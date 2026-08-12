//! Minimal MCP server: JSON-RPC 2.0 over plain HTTP POST.
//!
//! Written by hand instead of pulled from an SDK — the surface we need is four
//! methods wide, and the repo already writes JSON-RPC by hand in
//! `codex_app_server.rs`.
//!
//! Transport shape, from what claude 2.1.226 and codex 0.147.0 actually do:
//! - both advertise `Accept: application/json, text/event-stream` but accept a
//!   plain `application/json` answer, so there is no SSE machinery here;
//! - both try to open a server->client stream with `GET /mcp`, take the 405 and
//!   carry on;
//! - codex sends `DELETE /mcp` on shutdown.
//!
//! The server is stateless: identity is the per-terminal control token carried
//! on every request (`control_api`), never an `Mcp-Session-Id`. That is why
//! `initialize` issues no session id and `DELETE` has nothing to forget.
//!
//! `tools/list` is filtered by the caller's capabilities: a terminal without
//! `agent.spawn` never learns the spawn tool exists. Hiding beats denying —
//! a model that cannot see a tool does not spend turns retrying it.

use serde_json::{json, Value};
use std::io::Read;

use crate::control_api::{self, Capability, ControlToken};
use crate::control_bridge;

/// Protocol revisions we can speak, newest first.
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION: &str = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_NAME: &str = "alethe";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
const BODY_LIMIT: u64 = 1024 * 1024; // 1 MB

/// Longest wait `alethe_wait_for_done` may be asked for.
///
/// The bridge only gives that operation `control_bridge::ACTION_TIMEOUT` to
/// answer, and the executor answers *after* the wait it was asked for elapses,
/// so the ceiling has to stay below that window with margin to spare. Raising
/// this past the dispatch timeout would turn a wait that worked exactly as
/// requested into a `timeout` error for the model. See `timeout_for`.
const WAIT_TIMEOUT_CEILING_MS: u64 = 120_000;

// JSON-RPC 2.0 reserved codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
/// Outside the reserved range, as JSON-RPC requires for application errors.
const UNAUTHORIZED: i64 = -32001;

const INSTRUCTIONS: &str = "Alethe is a desktop workspace of live terminals and coding agents. \
These tools act on the workspace you are running inside, restricted to the project and group of \
your own terminal. Call alethe_whoami first: it reports which terminal you are and which \
capabilities your token carries. Tools you are not allowed to use are not listed at all, so \
everything you can see, you may call.\n\n\
WAITING ON A PERSON. Tools that change the workspace -- opening a shell, spawning an agent, \
sending a prompt, killing a terminal -- may pause while the user is asked to approve them. A call \
that takes a while is usually a dialog waiting for them, not a hang: let it finish rather than \
retrying, since a retry only queues a second question. If they decline you get a clear refusal \
saying a person refused; that is a decision, not an error to work around, so do not reissue the \
same request. Read-only tools never ask and answer immediately.\n\n\
CHOOSING A SHELL. You also have your own shell, and it is the right tool for quick commands whose \
output you need immediately, since alethe_run_shell never returns output. Prefer alethe_run_shell \
whenever the command outlives your reply or the user would want to watch it: dev servers, build \
and test watchers, log tails, database and container processes, anything you would background. \
Your own shell is invisible to the user and dies with your turn, so a server started there leaves \
them with a process they can neither see, read, nor stop. A shell opened through Alethe becomes a \
real pane in their workspace: they watch it live, and you read it back with alethe_read_output. \
When a request implies something keeps running -- 'start the app', 'run the dev server', 'watch \
the tests' -- open it in Alethe.";

/// One tool plus the capability its caller must hold to see it.
struct ToolSpec {
    name: &'static str,
    /// `None` means every token may call it.
    capability: Option<Capability>,
    description: &'static str,
    input_schema: Value,
}

impl ToolSpec {
    fn to_wire(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        })
    }
}

/// Every tool takes an object and rejects unknown keys, so a model cannot
/// smuggle in arguments the executor never agreed to read.
fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn catalog() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "alethe_whoami",
            capability: None,
            description:
                "Identify the calling terminal. Returns its terminal id, project id, group id and \
                 the capabilities this token carries.",
            input_schema: object_schema(json!({}), &[]),
        },
        ToolSpec {
            name: "alethe_list_terminals",
            capability: Some(Capability::TerminalList),
            description:
                "List the terminals inside your scope. Returns, for each one, its id, name, agent \
                 type, project id, whether it is running, idle or disabled, and its working \
                 directory.",
            input_schema: object_schema(json!({}), &[]),
        },
        ToolSpec {
            name: "alethe_read_output",
            capability: Some(Capability::TerminalRead),
            description:
                "Read the recent output of one terminal. Returns the tail of its scrollback as \
                 plain text with terminal control sequences stripped, oldest line first. A leading \
                 `…` means older output was cut.",
            input_schema: object_schema(
                json!({
                    "terminalId": {
                        "type": "string",
                        "description": "Terminal to read, as reported by alethe_list_terminals.",
                    },
                    // Characters, not lines: the executor tails the scrollback by
                    // length, and a schema promising lines would silently mean
                    // something else.
                    "maxChars": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 20000,
                        "default": 2000,
                        "description": "How many trailing characters of the scrollback to return.",
                    },
                }),
                &["terminalId"],
            ),
        },
        ToolSpec {
            name: "alethe_terminal_status",
            capability: Some(Capability::TerminalRead),
            description:
                "Check one terminal without reading its output. Returns whether it is running, \
                 idle or disabled, its agent type, its working directory and the project it \
                 belongs to.",
            input_schema: object_schema(
                json!({
                    "terminalId": {
                        "type": "string",
                        "description": "Terminal to inspect, as reported by alethe_list_terminals.",
                    },
                }),
                &["terminalId"],
            ),
        },
        ToolSpec {
            name: "alethe_run_shell",
            capability: Some(Capability::ShellRun),
            // The executor opens a REAL terminal a person can watch and type in,
            // so the description promises a job, never stdout: a created
            // terminal is not a finished command.
            description:
                "Open a real, visible shell terminal in the user's workspace and run one command in \
                 it. Use this instead of your own shell for anything that keeps running or that \
                 the user should be able to watch and stop: dev servers, watchers, log tails. \
                 Unlike your own shell, this one is visible to them and outlives your reply. \
                 Returns a job id and the state the request landed in — `starting`, or `queued` \
                 when the workspace is at its spawn ceiling — never the command output. Read what \
                 it printed afterwards with alethe_read_output. Do not send the same request twice: \
                 a queued request was already accepted and starts on its own.",
            input_schema: object_schema(
                json!({
                    "command": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 4000,
                        "description": "Single-line command to type into the new terminal.",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Directory to run in. Defaults to the project folder of your own terminal.",
                    },
                    "name": {
                        "type": "string",
                        "maxLength": 80,
                        "description": "Label for the new terminal in the Alethe UI. Defaults to the executable name.",
                    },
                }),
                &["command"],
            ),
        },
        ToolSpec {
            name: "alethe_events",
            capability: Some(Capability::EventsRead),
            description:
                "Read recent workspace events inside your scope (terminal spawned or exited, agent \
                 started or finished working). Returns events in chronological order, newest last.",
            input_schema: object_schema(
                json!({
                    "since": {
                        "type": "integer",
                        "minimum": 0,
                        "description": "Only return events newer than this Unix timestamp in milliseconds.",
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "default": 50,
                        "description": "Maximum number of events to return.",
                    },
                    "terminalId": {
                        "type": "string",
                        "description": "Only return events emitted by this terminal.",
                    },
                }),
                &[],
            ),
        },
        ToolSpec {
            name: "alethe_list_agents",
            capability: Some(Capability::AgentSpawn),
            // Says what Alethe can actually observe and nothing more. The app
            // reads usage windows and limits; it never learns the name of a
            // subscription, so the description forbids inventing one rather
            // than leaving the model free to guess "Max" or "Pro" and state it
            // as fact to the user.
            description:
                "List the agents this machine can actually run, so you can pick one before you \
                 delegate. Returns, for each agent type: whether its CLI is installed, whether it \
                 can orchestrate (drive other agents through these tools), and — only for \
                 providers that expose it — how much of the current usage window is already \
                 spent. It does NOT report the name of a commercial plan: Alethe sees usage \
                 windows and limits, never which subscription pays for them, so never infer a \
                 plan name and never state one as fact. Call this before alethe_spawn_agent and \
                 route by cost and availability — an agent whose quota is nearly spent, or that \
                 is not installed at all, is the wrong one to hand work to, and the most capable \
                 agent is rarely the right default for every task.",
            input_schema: object_schema(json!({}), &[]),
        },
        ToolSpec {
            name: "alethe_spawn_agent",
            capability: Some(Capability::AgentSpawn),
            description:
                "Start a new agent terminal in the workspace and hand it a task. Returns the id of \
                 the terminal that was created. You choose which agent and what it should do; \
                 Alethe chooses the command line it runs.",
            // Security invariant: this schema accepts exactly {agent, task, cwd, mode, name}.
            // No extra_args, no env, no launcher_override — the caller must never be able to
            // shape the command line, only to name the agent that runs.
            input_schema: object_schema(
                json!({
                    "agent": {
                        "type": "string",
                        // Mirrors `ALL_AGENT_TYPES` in src/lib/types.ts. Being
                        // spawnable and being able to orchestrate are separate:
                        // only claude and codex ship an MCP client, but every
                        // type here resolves through `agentCliCommand`.
                        "enum": [
                            "claude", "codex", "opencode", "antigravity",
                            "freebuff", "mimo", "shell",
                        ],
                        "description": "Which agent to start.",
                    },
                    "task": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The task to hand to the agent, in plain language.",
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Directory to start in. Defaults to the project folder of your own terminal.",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["exec", "interactive"],
                        "default": "exec",
                        "description": "'exec' runs the task once and exits; 'interactive' keeps \
                                        the agent open for follow-up prompts. A task spanning \
                                        several lines is always run with 'exec' when the agent \
                                        supports it — typed line breaks submit early in some CLIs, \
                                        which silently delivers only the first paragraph. The \
                                        answer says so when the mode is overruled.",
                    },
                    "name": {
                        "type": "string",
                        "maxLength": 80,
                        "description": "Label for the new terminal in the Alethe UI.",
                    },
                }),
                &["agent", "task"],
            ),
        },
        ToolSpec {
            name: "alethe_send_prompt",
            capability: Some(Capability::AgentPrompt),
            description:
                "Send a prompt to an agent terminal that is already running. Returns only an \
                 acknowledgement — read the answer afterwards with alethe_read_output.",
            input_schema: object_schema(
                json!({
                    "terminalId": {
                        "type": "string",
                        "description": "Terminal to prompt, as reported by alethe_list_terminals.",
                    },
                    "prompt": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Text to send to the agent.",
                    },
                    "submit": {
                        "type": "boolean",
                        "default": true,
                        "description": "Press Enter after typing. Set false to leave the text staged in the input.",
                    },
                }),
                &["terminalId", "prompt"],
            ),
        },
        ToolSpec {
            name: "alethe_wait_for_done",
            // Orchestration tier on purpose: an orchestrator token holds every
            // capability, so a tool gated here can never be listed to a caller
            // the executor would then deny — which is the promise `INSTRUCTIONS`
            // makes about this catalog.
            capability: Some(Capability::AgentSpawn),
            description:
                "Wait until a terminal stops working, instead of polling alethe_terminal_status in \
                 a loop. Use it after alethe_spawn_agent to let a delegated agent finish. Returns \
                 the state the terminal is in and whether it actually finished; running out of \
                 time is a normal answer, not a failure — you may simply wait again. Returns no \
                 output: read what it produced with alethe_read_output.",
            input_schema: object_schema(
                json!({
                    "terminalId": {
                        "type": "string",
                        "description": "Terminal to wait for, as reported by alethe_list_terminals.",
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 1000,
                        "maximum": WAIT_TIMEOUT_CEILING_MS,
                        "default": 60000,
                        "description": "How long to wait before giving up, in milliseconds. Two minutes at most; if the terminal is still working, wait again.",
                    },
                }),
                &["terminalId"],
            ),
        },
        ToolSpec {
            name: "alethe_kill_terminal",
            capability: Some(Capability::AgentKill),
            description:
                "Stop a terminal and the process tree it owns. Returns whether the terminal was \
                 still alive when the request arrived.",
            input_schema: object_schema(
                json!({
                    "terminalId": {
                        "type": "string",
                        "description": "Terminal to stop, as reported by alethe_list_terminals.",
                    },
                }),
                &["terminalId"],
            ),
        },
    ]
}

/// The tools this token is allowed to know about.
fn visible_tools(token: &ControlToken) -> Vec<ToolSpec> {
    catalog()
        .into_iter()
        .filter(|tool| match tool.capability {
            None => true,
            Some(capability) => token.allows(capability),
        })
        .collect()
}

/// How a single JSON-RPC message should be answered over HTTP.
enum Outcome {
    /// A JSON body to return with 200.
    Json(Value),
    /// A notification: 202 with no body.
    Accepted,
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Option<&Value>, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.cloned().unwrap_or(Value::Null),
        "error": { "code": code, "message": message.into() },
    })
}

/// Body returned on a missing or unknown token. Deliberately says nothing about
/// which tools exist — an unauthenticated caller learns only that it failed.
fn unauthorized_body() -> String {
    rpc_error(
        None,
        UNAUTHORIZED,
        "missing or unknown control token (send it as `Authorization: Bearer <token>` or `X-Alethe-Token: <token>`)",
    )
    .to_string()
}

/// Answers the id of a JSON-RPC message, or `None` when it is a notification.
///
/// An explicit `"id": null` is treated as a notification too: MCP forbids a null
/// id, so answering one would be more surprising than staying quiet.
fn message_id(message: &Value) -> Option<Value> {
    match message.get("id") {
        None | Some(Value::Null) => None,
        Some(id) => Some(id.clone()),
    }
}

/// Picks the protocol revision to answer with. An unknown (usually newer)
/// revision is downgraded to our latest instead of refused — both clients accept
/// the downgrade and keep going.
fn negotiate_protocol(requested: Option<&str>) -> &'static str {
    match requested {
        Some(version) => SUPPORTED_PROTOCOL_VERSIONS
            .into_iter()
            .find(|supported| *supported == version)
            .unwrap_or(LATEST_PROTOCOL_VERSION),
        None => LATEST_PROTOCOL_VERSION,
    }
}

fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str);
    json!({
        "protocolVersion": negotiate_protocol(requested),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "instructions": INSTRUCTIONS,
    })
}

/// Wraps a payload in the MCP tool-result envelope. The payload is serialized
/// into the text block because every MCP client can read text; `structuredContent`
/// is skipped since these tools declare no `outputSchema`.
fn tool_result(payload: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

fn not_implemented(tool: &str) -> Value {
    tool_result(
        &json!({
            "error": "not_implemented",
            "tool": tool,
            "message": format!(
                "`{tool}` has no executor yet. Your token and capabilities are valid, so retrying \
                 will not help until the Alethe UI ships the executor for this tool."
            ),
        }),
        true,
    )
}

/// Control-plane operation behind a tool, for the tools that have an executor.
///
/// `None` means the tool is declared but nothing runs it yet — the event feed
/// is read from a different store and ships separately.
fn op_for(tool: &str) -> Option<&'static str> {
    match tool {
        "alethe_list_terminals" => Some(control_bridge::OP_LIST_TERMINALS),
        "alethe_read_output" => Some(control_bridge::OP_READ_OUTPUT),
        "alethe_terminal_status" => Some(control_bridge::OP_TERMINAL_STATUS),
        "alethe_run_shell" => Some(control_bridge::OP_RUN_SHELL),
        "alethe_list_agents" => Some(control_bridge::OP_LIST_AGENTS),
        "alethe_spawn_agent" => Some(control_bridge::OP_SPAWN_AGENT),
        "alethe_send_prompt" => Some(control_bridge::OP_SEND_PROMPT),
        "alethe_wait_for_done" => Some(control_bridge::OP_WAIT_FOR_DONE),
        "alethe_kill_terminal" => Some(control_bridge::OP_KILL_TERMINAL),
        _ => None,
    }
}

/// The `arguments` object of a `tools/call`, defaulted to empty. A caller that
/// sends something that is not an object gets the same treatment as one that
/// sends nothing: the executor validates its own inputs.
fn tool_arguments(params: Option<&Value>) -> Value {
    params
        .and_then(|params| params.get("arguments"))
        .filter(|arguments| arguments.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}))
}

fn whoami_result(token: &ControlToken) -> Value {
    tool_result(
        &json!({
            "terminalId": token.terminal_id,
            "projectId": token.project_id,
            "groupId": token.group_id,
            "capabilities": token.capabilities,
        }),
        false,
    )
}

/// Runs one control-plane operation. Injected instead of called directly so the
/// whole JSON-RPC layer stays testable without a Tauri runtime and without a
/// live webview on the other end.
///
/// `Err` is the `{error: {code, ...}}` payload the model sees.
trait Executor: Fn(&ControlToken, &str, Value) -> Result<Value, Value> {}
impl<F: Fn(&ControlToken, &str, Value) -> Result<Value, Value>> Executor for F {}

fn call_tool<E: Executor>(
    token: &ControlToken,
    id: &Value,
    params: Option<&Value>,
    execute: &E,
) -> Value {
    let Some(name) = params
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
    else {
        return rpc_error(Some(id), INVALID_PARAMS, "tools/call requires a `name`");
    };

    // Looked up against the FILTERED catalog on purpose: a tool the caller
    // cannot see must also be unknown to it, otherwise the error message becomes
    // an oracle for capabilities the token does not hold.
    let Some(tool) = visible_tools(token)
        .into_iter()
        .find(|tool| tool.name == name)
    else {
        return rpc_error(Some(id), INVALID_PARAMS, format!("unknown tool: {name}"));
    };

    let result = match tool.name {
        // Answered from the token alone: no round trip can tell the caller who
        // it is better than the token it presented.
        "alethe_whoami" => whoami_result(token),
        other => match op_for(other) {
            Some(op) => match execute(token, op, tool_arguments(params)) {
                Ok(data) => tool_result(&data, false),
                Err(error) => tool_result(&error, true),
            },
            None => not_implemented(other),
        },
    };
    rpc_result(id, result)
}

/// Parses and answers one request body. Pure apart from `execute`: no globals,
/// no app handle, no transport.
fn respond_to_body<E: Executor>(token: &ControlToken, body: &str, execute: &E) -> Outcome {
    let message: Value = match serde_json::from_str(body) {
        Ok(message) => message,
        Err(error) => {
            return Outcome::Json(rpc_error(
                None,
                PARSE_ERROR,
                format!("invalid JSON: {error}"),
            ))
        }
    };

    // MCP dropped JSON-RPC batching in 2025-06-18; neither client sends one.
    if message.is_array() {
        return Outcome::Json(rpc_error(
            None,
            INVALID_REQUEST,
            "batch requests are not supported",
        ));
    }

    let id = message_id(&message);

    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Outcome::Json(rpc_error(
            id.as_ref(),
            INVALID_REQUEST,
            "expected `\"jsonrpc\": \"2.0\"`",
        ));
    }

    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Outcome::Json(rpc_error(id.as_ref(), INVALID_REQUEST, "missing `method`"));
    };

    // Notifications get no body at all — `notifications/initialized` included.
    let Some(id) = id else {
        return Outcome::Accepted;
    };

    let params = message.get("params");
    let answer = match method {
        "initialize" => rpc_result(&id, initialize_result(params)),
        "ping" => rpc_result(&id, json!({})),
        "tools/list" => rpc_result(
            &id,
            json!({
                "tools": visible_tools(token)
                    .iter()
                    .map(ToolSpec::to_wire)
                    .collect::<Vec<_>>(),
            }),
        ),
        "tools/call" => call_tool(token, &id, params, execute),
        unknown => rpc_error(
            Some(&id),
            METHOD_NOT_FOUND,
            format!("method not found: {unknown}"),
        ),
    };
    Outcome::Json(answer)
}

/// Reads `Authorization: Bearer <token>` or `X-Alethe-Token: <token>`, in that
/// order of preference.
fn token_from_headers(headers: &[(String, String)]) -> Option<String> {
    let mut bearer = None;
    let mut direct = None;
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("authorization") {
            if let Some(token) = strip_bearer(value) {
                bearer = Some(token.to_string());
            }
        } else if name.eq_ignore_ascii_case("x-alethe-token") {
            let value = value.trim();
            if !value.is_empty() {
                direct = Some(value.to_string());
            }
        }
    }
    bearer.or(direct)
}

fn strip_bearer(value: &str) -> Option<&str> {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() > 7 && bytes[..6].eq_ignore_ascii_case(b"bearer") && bytes[6] == b' ' {
        // Byte 0..7 is ASCII, so this slice is always on a char boundary.
        let token = value[7..].trim();
        (!token.is_empty()).then_some(token)
    } else {
        None
    }
}

fn json_response(status: u16, body: String) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    tiny_http::Response::from_string(body)
        .with_status_code(status)
        .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap())
}

/// HTTP entry point for `/mcp`, called by the `agent_events` listener before its
/// global token check — this route authenticates per terminal instead.
///
/// Runs on the per-request thread that listener hands out, which is what makes
/// it safe for a tool call to park here until the frontend answers.
pub fn handle(app: &tauri::AppHandle, mut request: tiny_http::Request) {
    match request.method() {
        // Both clients try to open a server->client stream here, take the 405
        // and fall back to plain request/response. Answering it is what keeps
        // them from retrying.
        tiny_http::Method::Get => {
            let response = tiny_http::Response::empty(405)
                .with_header(tiny_http::Header::from_bytes("Allow", "POST, DELETE").unwrap());
            let _ = request.respond(response);
            return;
        }
        // codex sends this on shutdown. Nothing to forget: the server keeps no
        // session state, identity travels on the token.
        tiny_http::Method::Delete => {
            let _ = request.respond(tiny_http::Response::empty(200));
            return;
        }
        tiny_http::Method::Post => {}
        _ => {
            let response = tiny_http::Response::empty(405)
                .with_header(tiny_http::Header::from_bytes("Allow", "POST, DELETE").unwrap());
            let _ = request.respond(response);
            return;
        }
    }

    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|header| {
            (
                header.field.as_str().as_str().to_string(),
                header.value.as_str().to_string(),
            )
        })
        .collect();

    let token = token_from_headers(&headers).and_then(|presented| control_api::resolve(&presented));
    let Some(token) = token else {
        // No `WWW-Authenticate` header on purpose: advertising a challenge sends
        // MCP clients down the OAuth discovery path, and this token is minted by
        // Alethe itself, never negotiated.
        let _ = request.respond(json_response(401, unauthorized_body()));
        return;
    };

    let mut body = String::new();
    if let Err(error) = request.as_reader().take(BODY_LIMIT).read_to_string(&mut body) {
        let _ = request.respond(json_response(
            400,
            rpc_error(None, PARSE_ERROR, format!("could not read body: {error}")).to_string(),
        ));
        return;
    }

    let execute = |token: &ControlToken, op: &str, params: Value| {
        control_bridge::dispatch(app, token, op, params)
    };
    match respond_to_body(&token, &body, &execute) {
        Outcome::Json(answer) => {
            let _ = request.respond(json_response(200, answer.to_string()));
        }
        Outcome::Accepted => {
            let _ = request.respond(tiny_http::Response::empty(202));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_api::capabilities_for;

    fn token(orchestrator: bool) -> ControlToken {
        ControlToken {
            token: "test-token".to_string(),
            terminal_id: "term-1".to_string(),
            project_id: "proj-api".to_string(),
            group_id: Some("grp-backend".to_string()),
            capabilities: capabilities_for(orchestrator),
            issued_at_ms: 0,
        }
    }

    /// Executor that refuses everything, for the cases where no tool should be
    /// executed at all.
    fn no_executor() -> impl Executor {
        |_: &ControlToken, op: &str, _: Value| -> Result<Value, Value> {
            panic!("no tool should have reached the executor, but `{op}` did")
        }
    }

    /// Executor that echoes back what it was asked to run, so a test can assert
    /// on the op and the params that crossed the bridge.
    fn echo_executor() -> impl Executor {
        |token: &ControlToken, op: &str, params: Value| {
            Ok(json!({ "op": op, "params": params, "caller": token.terminal_id }))
        }
    }

    fn answer(token: &ControlToken, body: &str) -> Value {
        answer_with(token, body, &no_executor())
    }

    fn answer_with<E: Executor>(token: &ControlToken, body: &str, execute: &E) -> Value {
        match respond_to_body(token, body, execute) {
            Outcome::Json(value) => value,
            Outcome::Accepted => panic!("expected a JSON answer, got a 202"),
        }
    }

    /// The payload the model actually reads, parsed back out of the text block.
    fn tool_payload(result: &Value) -> Value {
        let text = result["result"]["content"][0]["text"]
            .as_str()
            .expect("text block");
        serde_json::from_str(text).expect("tool payload is JSON")
    }

    fn call(name: &str, arguments: Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        })
        .to_string()
    }

    fn tool_names(token: &ControlToken) -> Vec<String> {
        answer(token, r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)["result"]["tools"]
            .as_array()
            .expect("tools array")
            .iter()
            .map(|tool| tool["name"].as_str().expect("tool name").to_string())
            .collect()
    }

    #[test]
    fn tools_list_hides_orchestration_from_a_plain_terminal() {
        let names = tool_names(&token(false));
        assert!(names.contains(&"alethe_whoami".to_string()));
        assert!(names.contains(&"alethe_run_shell".to_string()));
        // Hidden, not merely denied: the model must not see them at all.
        assert!(!names.contains(&"alethe_spawn_agent".to_string()));
        assert!(!names.contains(&"alethe_send_prompt".to_string()));
        assert!(!names.contains(&"alethe_kill_terminal".to_string()));
        assert!(!names.contains(&"alethe_wait_for_done".to_string()));
        // Knowing which agents exist is only useful to someone who may spawn
        // one, and a shorter tool list is a better one.
        assert!(!names.contains(&"alethe_list_agents".to_string()));
    }

    #[test]
    fn tools_list_shows_orchestration_to_an_orchestrator() {
        let names = tool_names(&token(true));
        assert_eq!(names.len(), catalog().len());
        for expected in [
            "alethe_list_agents",
            "alethe_spawn_agent",
            "alethe_send_prompt",
            "alethe_wait_for_done",
            "alethe_kill_terminal",
        ] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn asking_for_the_agent_roster_takes_no_arguments_and_needs_agent_spawn() {
        let roster = catalog()
            .into_iter()
            .find(|tool| tool.name == "alethe_list_agents")
            .expect("list_agents tool");
        assert_eq!(roster.capability, Some(Capability::AgentSpawn));
        assert_eq!(roster.input_schema["properties"], json!({}));
        assert_eq!(roster.input_schema["required"], json!([]));
        assert_eq!(roster.input_schema["additionalProperties"], false);

        // Hidden from a plain terminal exactly like any other orchestration
        // tool: same error as a tool that does not exist.
        let hidden = answer(&token(false), &call("alethe_list_agents", json!({})));
        assert_eq!(hidden["error"]["code"], INVALID_PARAMS);
        assert!(hidden.get("result").is_none());
    }

    #[test]
    fn every_tool_declares_an_object_schema() {
        for tool in catalog() {
            let schema = &tool.input_schema;
            assert_eq!(schema["type"], "object", "{} schema type", tool.name);
            assert_eq!(
                schema["additionalProperties"], false,
                "{} must reject unknown keys",
                tool.name
            );
            for required in schema["required"].as_array().expect("required array") {
                let key = required.as_str().expect("required key");
                assert!(
                    schema["properties"].get(key).is_some(),
                    "{} requires `{key}` but never declares it",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn spawn_agent_never_exposes_the_command_line() {
        let spawn = catalog()
            .into_iter()
            .find(|tool| tool.name == "alethe_spawn_agent")
            .expect("spawn tool");
        let properties = spawn.input_schema["properties"]
            .as_object()
            .expect("properties object");
        let mut keys: Vec<&str> = properties.keys().map(String::as_str).collect();
        keys.sort_unstable();
        // The client picks WHICH agent; Alethe picks WHICH command.
        assert_eq!(keys, ["agent", "cwd", "mode", "name", "task"]);
        assert_eq!(spawn.input_schema["additionalProperties"], false);

        // And WHICH agent is a closed set: exactly `ALL_AGENT_TYPES` from
        // src/lib/types.ts, nothing else. Drifting from that list is a bug in
        // either direction — an agent the app can spawn but the orchestrator
        // cannot ask for, or one it can ask for and the app cannot start.
        let mut agents: Vec<&str> = properties["agent"]["enum"]
            .as_array()
            .expect("agent enum")
            .iter()
            .map(|value| value.as_str().expect("enum entry is a string"))
            .collect();
        agents.sort_unstable();
        assert_eq!(
            agents,
            [
                "antigravity", "claude", "codex", "freebuff", "mimo", "opencode", "shell",
            ]
        );
    }

    #[test]
    fn initialize_echoes_a_supported_version() {
        let result = answer(
            &token(false),
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
        );
        assert_eq!(result["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(result["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn initialize_downgrades_an_unknown_version() {
        let result = answer(
            &token(false),
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#,
        );
        assert_eq!(result["result"]["protocolVersion"], LATEST_PROTOCOL_VERSION);

        // A client that omits the field gets our latest too.
        let result = answer(
            &token(false),
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        );
        assert_eq!(result["result"]["protocolVersion"], LATEST_PROTOCOL_VERSION);
    }

    #[test]
    fn unknown_method_is_a_jsonrpc_method_not_found() {
        let result = answer(
            &token(true),
            r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#,
        );
        assert_eq!(result["id"], 7);
        assert_eq!(result["error"]["code"], METHOD_NOT_FOUND);
        assert!(result.get("result").is_none());
    }

    #[test]
    fn notifications_get_no_body() {
        assert!(matches!(
            respond_to_body(
                &token(false),
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &no_executor(),
            ),
            Outcome::Accepted
        ));
    }

    #[test]
    fn ping_answers_an_empty_result() {
        let result = answer(&token(false), r#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#);
        assert_eq!(result["id"], "a");
        assert_eq!(result["result"], json!({}));
    }

    #[test]
    fn malformed_bodies_become_jsonrpc_errors() {
        let parse = answer(&token(false), "not json at all");
        assert_eq!(parse["error"]["code"], PARSE_ERROR);

        let wrong_version = answer(&token(false), r#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#);
        assert_eq!(wrong_version["error"]["code"], INVALID_REQUEST);

        let no_method = answer(&token(false), r#"{"jsonrpc":"2.0","id":1}"#);
        assert_eq!(no_method["error"]["code"], INVALID_REQUEST);

        let batch = answer(&token(false), r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#);
        assert_eq!(batch["error"]["code"], INVALID_REQUEST);
    }

    #[test]
    fn whoami_answers_from_the_token_alone() {
        let result = answer(
            &token(false),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"alethe_whoami","arguments":{}}}"#,
        );
        assert_eq!(result["result"]["isError"], false);
        let text = result["result"]["content"][0]["text"]
            .as_str()
            .expect("text block");
        let payload: Value = serde_json::from_str(text).expect("whoami payload is JSON");
        assert_eq!(payload["terminalId"], "term-1");
        assert_eq!(payload["projectId"], "proj-api");
        assert_eq!(payload["groupId"], "grp-backend");
        assert_eq!(payload["capabilities"], json!(capabilities_for(false)));
    }

    #[test]
    fn the_shell_tier_tools_reach_the_executor_with_their_own_operation() {
        let executor = echo_executor();
        for (tool, arguments, op) in [
            ("alethe_list_terminals", json!({}), "list_terminals"),
            (
                "alethe_read_output",
                json!({ "terminalId": "term-2", "maxChars": 500 }),
                "read_output",
            ),
            (
                "alethe_terminal_status",
                json!({ "terminalId": "term-2" }),
                "terminal_status",
            ),
            (
                "alethe_run_shell",
                json!({ "command": "npm test" }),
                "run_shell",
            ),
        ] {
            let result = answer_with(&token(false), &call(tool, arguments.clone()), &executor);
            assert_eq!(result["result"]["isError"], false, "{tool} should succeed");
            let payload = tool_payload(&result);
            assert_eq!(payload["op"], op, "{tool} routed to the wrong operation");
            assert_eq!(payload["params"], arguments, "{tool} lost its arguments");
            assert_eq!(payload["caller"], "term-1");
        }
    }

    #[test]
    fn the_orchestration_tools_reach_the_executor_with_their_own_operation() {
        let executor = echo_executor();
        for (tool, arguments, op) in [
            ("alethe_list_agents", json!({}), "list_agents"),
            (
                "alethe_spawn_agent",
                json!({ "agent": "codex", "task": "port the parser" }),
                "spawn_agent",
            ),
            (
                "alethe_send_prompt",
                json!({ "terminalId": "term-2", "prompt": "status?" }),
                "send_prompt",
            ),
            (
                "alethe_wait_for_done",
                json!({ "terminalId": "term-2", "timeoutMs": 30000 }),
                "wait_for_done",
            ),
            (
                "alethe_kill_terminal",
                json!({ "terminalId": "term-2" }),
                "kill_terminal",
            ),
        ] {
            // Orchestration is invisible to a plain terminal, so this tier is
            // only reachable with an orchestrator token.
            let result = answer_with(&token(true), &call(tool, arguments.clone()), &executor);
            assert_eq!(result["result"]["isError"], false, "{tool} should succeed");
            let payload = tool_payload(&result);
            assert_eq!(payload["op"], op, "{tool} routed to the wrong operation");
            assert_eq!(payload["params"], arguments, "{tool} lost its arguments");
            assert_eq!(payload["caller"], "term-1");
        }
    }

    #[test]
    fn a_wait_can_never_be_asked_to_outlast_its_own_dispatch_window() {
        // The executor answers only once the requested wait elapses, so a
        // `timeoutMs` the schema allows must still fit inside the time the
        // bridge gives the operation — otherwise a wait that worked exactly as
        // asked would come back to the model as a bridge `timeout`.
        let wait = catalog()
            .into_iter()
            .find(|tool| tool.name == "alethe_wait_for_done")
            .expect("wait tool");
        let maximum = wait.input_schema["properties"]["timeoutMs"]["maximum"]
            .as_u64()
            .expect("timeoutMs declares a maximum");
        assert_eq!(maximum, WAIT_TIMEOUT_CEILING_MS);
        assert_eq!(maximum, 120_000, "a wait is capped at two minutes");

        let window = control_bridge::timeout_for(control_bridge::OP_WAIT_FOR_DONE);
        assert_eq!(window, control_bridge::ACTION_TIMEOUT);
        assert!(
            u128::from(maximum) < window.as_millis(),
            "a {maximum}ms wait cannot be answered within a {}ms dispatch window",
            window.as_millis(),
        );
    }

    #[test]
    fn an_executor_failure_becomes_an_error_result_the_model_can_read() {
        let executor =
            |_: &ControlToken, _: &str, _: Value| Err(json!({ "error": { "code": "timeout" } }));
        let result = answer_with(&token(false), &call("alethe_list_terminals", json!({})), &executor);
        // isError, not a JSON-RPC error: the call was well formed, the work failed.
        assert_eq!(result["result"]["isError"], true);
        assert!(result.get("error").is_none());
        assert_eq!(tool_payload(&result)["error"]["code"], "timeout");
    }

    #[test]
    fn missing_arguments_still_reach_the_executor_as_an_object() {
        // The executor owns input validation; the transport must not invent a
        // second, divergent gate here.
        let executor = echo_executor();
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"alethe_list_terminals"}}"#;
        assert_eq!(tool_payload(&answer_with(&token(false), body, &executor))["params"], json!({}));

        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"alethe_run_shell","arguments":"rm -rf /"}}"#;
        assert_eq!(tool_payload(&answer_with(&token(false), body, &executor))["params"], json!({}));
    }

    #[test]
    fn every_tool_either_has_an_executor_or_says_so() {
        // A tool that is neither dispatched nor explicitly unimplemented would
        // fail in some third, unexamined way. The partition shrank as the
        // orchestration tier got its executor: the event feed is the only tool
        // still waiting for one.
        const AWAITING_AN_EXECUTOR: [&str; 1] = ["alethe_events"];
        for tool in catalog() {
            let implemented = tool.name == "alethe_whoami" || op_for(tool.name).is_some();
            let declared_missing = AWAITING_AN_EXECUTOR.contains(&tool.name);
            assert!(
                implemented ^ declared_missing,
                "{} is neither executed nor declared unimplemented",
                tool.name
            );
        }
        // And the list above names nothing that quietly grew an executor.
        for name in AWAITING_AN_EXECUTOR {
            assert!(
                catalog().iter().any(|tool| tool.name == name),
                "{name} is listed as unimplemented but is not a tool"
            );
        }
    }

    #[test]
    fn unimplemented_tools_answer_a_structured_not_implemented() {
        let result = answer(
            &token(true),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"alethe_events","arguments":{"limit":10}}}"#,
        );
        assert_eq!(result["result"]["isError"], true);
        let text = result["result"]["content"][0]["text"]
            .as_str()
            .expect("text block");
        let payload: Value = serde_json::from_str(text).expect("error payload is JSON");
        assert_eq!(payload["error"], "not_implemented");
        assert_eq!(payload["tool"], "alethe_events");
    }

    #[test]
    fn calling_a_hidden_tool_looks_exactly_like_calling_a_missing_one() {
        let hidden = answer(
            &token(false),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"alethe_spawn_agent","arguments":{}}}"#,
        );
        let missing = answer(
            &token(false),
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"alethe_not_a_tool","arguments":{}}}"#,
        );
        assert_eq!(hidden["error"]["code"], INVALID_PARAMS);
        assert_eq!(missing["error"]["code"], INVALID_PARAMS);
        assert!(hidden.get("result").is_none());
    }

    #[test]
    fn the_unauthorized_body_names_no_tool() {
        let body = unauthorized_body();
        assert!(!body.contains("alethe_"), "leaked a tool name: {body}");
        for tool in catalog() {
            assert!(!body.contains(tool.name), "leaked {}", tool.name);
        }
    }

    #[test]
    fn reads_the_token_from_either_header() {
        let bearer = vec![("Authorization".into(), "Bearer abc123".into())];
        assert_eq!(token_from_headers(&bearer).as_deref(), Some("abc123"));

        let custom = vec![("x-alethe-token".into(), "abc123".into())];
        assert_eq!(token_from_headers(&custom).as_deref(), Some("abc123"));

        // Header names are case-insensitive and the scheme keyword is too.
        let odd_case = vec![("AUTHORIZATION".into(), "bearer abc123".into())];
        assert_eq!(token_from_headers(&odd_case).as_deref(), Some("abc123"));
    }

    #[test]
    fn rejects_header_shapes_that_carry_no_token() {
        assert!(token_from_headers(&[]).is_none());
        assert!(token_from_headers(&[("Authorization".into(), "Basic abc".into())]).is_none());
        assert!(token_from_headers(&[("Authorization".into(), "Bearer ".into())]).is_none());
        assert!(token_from_headers(&[("X-Alethe-Token".into(), "   ".into())]).is_none());
        // A non-ASCII value must not panic while the scheme is inspected.
        assert!(token_from_headers(&[("Authorization".into(), "Bearér".into())]).is_none());
    }

    #[test]
    fn negotiation_covers_every_advertised_version() {
        for version in SUPPORTED_PROTOCOL_VERSIONS {
            assert_eq!(negotiate_protocol(Some(version)), version);
        }
        assert_eq!(negotiate_protocol(None), LATEST_PROTOCOL_VERSION);
        assert_eq!(negotiate_protocol(Some("")), LATEST_PROTOCOL_VERSION);
    }
}
