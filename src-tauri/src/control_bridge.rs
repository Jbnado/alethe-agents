//! Request/reply bridge between the MCP server (here) and the control-plane
//! executor (the frontend).
//!
//! The executor lives in the webview because the backend cannot see the
//! workspace as it is right now: `projects.json` is written to disk with a
//! debounce, so a terminal created seconds ago exists only in the Zustand
//! store. This module is the wire between the two.
//!
//! Shape of one call: `dispatch` registers a one-shot channel under a fresh
//! request id, emits `alethe://control-request`, and parks the CALLING thread
//! on `recv_timeout` until `control_api_reply` delivers an answer.
//!
//! Parking is safe because `agent_events::dispatch_concurrently` already gives
//! every incoming HTTP request its own thread — the accept loop never waits
//! here, and one agent waiting on a human cannot freeze another agent's call.

use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::control_api::ControlToken;

/// Event the frontend listener subscribes to.
pub const CONTROL_REQUEST_EVENT: &str = "alethe://control-request";

/// Operations the frontend executor implements. Kept as constants so the tool
/// catalog and the bridge cannot drift apart on a typo.
pub const OP_LIST_TERMINALS: &str = "list_terminals";
pub const OP_READ_OUTPUT: &str = "read_output";
pub const OP_TERMINAL_STATUS: &str = "terminal_status";
pub const OP_RUN_SHELL: &str = "run_shell";
pub const OP_LIST_AGENTS: &str = "list_agents";
pub const OP_SPAWN_AGENT: &str = "spawn_agent";
pub const OP_SEND_PROMPT: &str = "send_prompt";
pub const OP_KILL_TERMINAL: &str = "kill_terminal";
pub const OP_WAIT_FOR_DONE: &str = "wait_for_done";

/// Reads are answered from memory. Taking longer than this means the webview is
/// wedged, not that anyone is thinking about it.
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Anything that can park behind a human decision in the UI waits on a human
/// timescale instead.
///
/// Paired with `APPROVAL_TIMEOUT_MS` (120s) in `src/lib/orchestrator/ops.ts`:
/// the approval dialog refuses on its own 30s before this deadline, so a
/// refusal always has time to travel back. The two move together — shrinking
/// this one below the dialog's deadline turns "a person refused" into a bare
/// transport timeout, which the model cannot tell apart from a wedged webview.
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(150);

pub fn timeout_for(op: &str) -> Duration {
    match op {
        // Spawning, prompting and killing can all park behind a person in the
        // UI, and `wait_for_done` parks by design.
        //
        // `wait_for_done` is the one operation whose own argument sets its
        // duration: the tool caps `timeoutMs` at 120_000 (`mcp_server::catalog`)
        // and the executor only answers once that deadline is reached, so this
        // window must sit ABOVE the tool's ceiling — otherwise the bridge would
        // give up on a wait that is working exactly as asked, and the model
        // would read `timeout` for a wait it was told it could request. The 30s
        // between 120s and 150s is the margin; the two numbers move together.
        OP_RUN_SHELL | OP_SPAWN_AGENT | OP_SEND_PROMPT | OP_KILL_TERMINAL | OP_WAIT_FOR_DONE => {
            ACTION_TIMEOUT
        }
        _ => READ_TIMEOUT,
    }
}

fn pending() -> &'static Mutex<HashMap<String, Sender<Value>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Sender<Value>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers a waiter and returns its id plus the end it will listen on.
fn register() -> (String, Receiver<Value>) {
    let request_id = format!("ctl-{}", nanoid::nanoid!(16));
    let (sender, receiver) = mpsc::channel();
    pending()
        .lock()
        .expect("control bridge pending map poisoned")
        .insert(request_id.clone(), sender);
    (request_id, receiver)
}

/// Drops a waiter. Idempotent on purpose: the timeout path and the reply path
/// race, and whichever loses must not care.
fn forget(request_id: &str) {
    pending()
        .lock()
        .expect("control bridge pending map poisoned")
        .remove(request_id);
}

#[cfg(test)]
fn is_pending(request_id: &str) -> bool {
    pending()
        .lock()
        .expect("control bridge pending map poisoned")
        .contains_key(request_id)
}

/// Hands a reply to whoever is waiting for it.
///
/// Returns false when nobody is — an id that already timed out, was answered
/// once, or was never issued. That is a no-op and never a panic: this value
/// comes from the webview, and a wrong id must not be able to take the app
/// down.
pub fn deliver(request_id: &str, result: Value) -> bool {
    let sender = pending()
        .lock()
        .expect("control bridge pending map poisoned")
        .remove(request_id);
    match sender {
        Some(sender) => sender.send(result).is_ok(),
        None => false,
    }
}

/// The frontend answers a control request here.
#[tauri::command]
pub fn control_api_reply(request_id: String, result: Value) -> bool {
    deliver(&request_id, result)
}

/// Failure payload handed to the model: always an object with a machine
/// readable `code`, never bare prose.
fn control_error(code: &str, message: impl Into<String>) -> Value {
    json!({ "error": { "code": code, "message": message.into() } })
}

/// Reads the reply envelope the frontend promised: `{ok: true, data}` or
/// `{ok: false, error}`. Anything else is treated as malformed rather than
/// passed through — the webview is not a trusted peer.
fn interpret(reply: Value) -> Result<Value, Value> {
    match reply.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(reply.get("data").cloned().unwrap_or(Value::Null)),
        Some(false) => match reply.get("error") {
            Some(error) if error.is_object() => Err(json!({ "error": error })),
            _ => Err(control_error(
                "error",
                "the Alethe UI refused the request without giving a reason",
            )),
        },
        None => Err(control_error(
            "malformed_reply",
            "the Alethe UI answered with a payload that is neither a result nor an error",
        )),
    }
}

/// Sends one control request to the frontend and waits for its answer.
///
/// `Ok` carries the operation payload; `Err` carries a `{error: {code, ...}}`
/// object, so every failure — denial, timeout, dead webview — reaches the model
/// in the same shape.
pub fn dispatch(
    app: &AppHandle,
    token: &ControlToken,
    op: &str,
    params: Value,
) -> Result<Value, Value> {
    dispatch_with(
        |payload| {
            app.emit(CONTROL_REQUEST_EVENT, payload)
                .map_err(|error| error.to_string())
        },
        token,
        op,
        params,
        timeout_for(op),
    )
}

/// Transport-agnostic core of `dispatch`, so the pending-map contract can be
/// tested without a Tauri runtime.
fn dispatch_with<E>(
    emit: E,
    token: &ControlToken,
    op: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, Value>
where
    E: FnOnce(&Value) -> Result<(), String>,
{
    let (request_id, receiver) = register();
    let payload = json!({
        "requestId": request_id,
        "ctx": {
            "terminalId": token.terminal_id,
            "projectId": token.project_id,
            "groupId": token.group_id,
            "capabilities": token.capabilities,
        },
        "op": op,
        "params": params,
    });

    // A request nobody will ever hear about must not stay in the map.
    if let Err(error) = emit(&payload) {
        forget(&request_id);
        return Err(control_error(
            "unreachable",
            format!("could not reach the Alethe UI: {error}"),
        ));
    }

    let answer = receiver.recv_timeout(timeout);
    forget(&request_id);
    match answer {
        Ok(reply) => interpret(reply),
        Err(RecvTimeoutError::Timeout) => Err(control_error(
            "timeout",
            format!(
                "the Alethe UI did not answer `{op}` within {}s",
                timeout.as_secs()
            ),
        )),
        // The sender is only dropped when the entry is removed without being
        // used, which means the request was already abandoned.
        Err(RecvTimeoutError::Disconnected) => Err(control_error(
            "abandoned",
            format!("the Alethe UI dropped the request for `{op}`"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_api::capabilities_for;
    use std::sync::mpsc::channel;
    use std::thread;

    const FAST: Duration = Duration::from_millis(50);

    fn token() -> ControlToken {
        ControlToken {
            token: "test-token".to_string(),
            terminal_id: "term-1".to_string(),
            project_id: "proj-api".to_string(),
            group_id: Some("grp-backend".to_string()),
            capabilities: capabilities_for(false),
            issued_at_ms: 0,
        }
    }

    fn request_id_of(payload: &Value) -> String {
        payload["requestId"]
            .as_str()
            .expect("requestId is a string")
            .to_string()
    }

    #[test]
    fn a_reply_answers_the_dispatch_that_asked_for_it() {
        let result = dispatch_with(
            |payload| {
                let request_id = request_id_of(payload);
                // Answer from another thread: the dispatching one is parked.
                thread::spawn(move || {
                    assert!(deliver(&request_id, json!({ "ok": true, "data": { "terminals": [] } })));
                });
                Ok(())
            },
            &token(),
            OP_LIST_TERMINALS,
            json!({}),
            Duration::from_secs(5),
        );
        assert_eq!(result.expect("a result"), json!({ "terminals": [] }));
    }

    #[test]
    fn the_event_payload_carries_the_scope_of_the_calling_token() {
        let (seen, received) = channel();
        let _ = dispatch_with(
            |payload| {
                seen.send(payload.clone()).expect("payload captured");
                Ok(())
            },
            &token(),
            OP_READ_OUTPUT,
            json!({ "terminalId": "term-2" }),
            FAST,
        );
        let payload = received.recv().expect("one payload");
        assert_eq!(payload["op"], OP_READ_OUTPUT);
        assert_eq!(payload["params"]["terminalId"], "term-2");
        assert_eq!(payload["ctx"]["terminalId"], "term-1");
        assert_eq!(payload["ctx"]["projectId"], "proj-api");
        assert_eq!(payload["ctx"]["groupId"], "grp-backend");
        assert_eq!(payload["ctx"]["capabilities"], json!(capabilities_for(false)));
        assert!(payload["requestId"].as_str().is_some_and(|id| !id.is_empty()));
    }

    #[test]
    fn a_timeout_answers_a_structured_error_and_leaves_no_pending_entry() {
        let (seen, received) = channel();
        let error = dispatch_with(
            |payload| {
                seen.send(request_id_of(payload)).expect("id captured");
                Ok(())
            },
            &token(),
            OP_LIST_TERMINALS,
            json!({}),
            FAST,
        )
        .expect_err("a silent UI must time out");

        assert_eq!(error["error"]["code"], "timeout");
        let request_id = received.recv().expect("one id");
        // A leak here would grow the map for every agent call that ever timed out.
        assert!(!is_pending(&request_id), "pending entry survived the timeout");
        // And the late reply that finally shows up has nowhere to go.
        assert!(!deliver(&request_id, json!({ "ok": true, "data": {} })));
    }

    #[test]
    fn a_failed_emit_leaves_no_pending_entry_either() {
        let (seen, received) = channel();
        let error = dispatch_with(
            |payload| {
                seen.send(request_id_of(payload)).expect("id captured");
                Err("no webview".to_string())
            },
            &token(),
            OP_LIST_TERMINALS,
            json!({}),
            Duration::from_secs(30),
        )
        .expect_err("an unreachable UI is an error");

        assert_eq!(error["error"]["code"], "unreachable");
        assert!(!is_pending(&received.recv().expect("one id")));
    }

    #[test]
    fn two_concurrent_dispatches_never_cross_answers() {
        let threads: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|tag| {
                thread::spawn(move || {
                    dispatch_with(
                        |payload| {
                            let request_id = request_id_of(payload);
                            thread::spawn(move || {
                                deliver(&request_id, json!({ "ok": true, "data": { "tag": tag } }));
                            });
                            Ok(())
                        },
                        &token(),
                        OP_LIST_TERMINALS,
                        json!({}),
                        Duration::from_secs(5),
                    )
                    .map(|data| (tag, data))
                })
            })
            .collect();

        for thread in threads {
            let (tag, data) = thread.join().expect("thread joined").expect("a result");
            assert_eq!(data["tag"], tag, "{tag} got another request's answer");
        }
    }

    #[test]
    fn a_reply_for_an_unknown_request_is_a_no_op() {
        assert!(!deliver("ctl-never-issued", json!({ "ok": true, "data": {} })));
        assert!(!control_api_reply(
            "ctl-never-issued".to_string(),
            json!({ "ok": true })
        ));
    }

    #[test]
    fn a_second_reply_to_the_same_request_finds_nobody() {
        let (seen, received) = channel();
        let _ = dispatch_with(
            |payload| {
                let request_id = request_id_of(payload);
                seen.send(request_id.clone()).expect("id captured");
                thread::spawn(move || {
                    deliver(&request_id, json!({ "ok": true, "data": {} }));
                });
                Ok(())
            },
            &token(),
            OP_LIST_TERMINALS,
            json!({}),
            Duration::from_secs(5),
        );
        assert!(!deliver(&received.recv().expect("one id"), json!({ "ok": true, "data": {} })));
    }

    #[test]
    fn a_denial_from_the_frontend_stays_a_structured_error() {
        let error = interpret(json!({
            "ok": false,
            "error": { "code": "denied", "message": "out of scope" },
        }))
        .expect_err("a denial is an error");
        assert_eq!(error["error"]["code"], "denied");
        assert_eq!(error["error"]["message"], "out of scope");
    }

    #[test]
    fn a_reply_that_honours_no_envelope_is_not_taken_as_data() {
        let error = interpret(json!({ "terminals": [] })).expect_err("no envelope, no trust");
        assert_eq!(error["error"]["code"], "malformed_reply");

        let error = interpret(json!({ "ok": false })).expect_err("a denial without a reason");
        assert_eq!(error["error"]["code"], "error");
    }

    #[test]
    fn only_the_operations_that_can_wait_on_a_human_get_the_long_timeout() {
        for op in [
            OP_RUN_SHELL,
            OP_SPAWN_AGENT,
            OP_SEND_PROMPT,
            OP_KILL_TERMINAL,
            OP_WAIT_FOR_DONE,
        ] {
            assert_eq!(timeout_for(op), ACTION_TIMEOUT, "{op} may wait on a human");
        }
        for op in [
            OP_LIST_TERMINALS,
            OP_READ_OUTPUT,
            OP_TERMINAL_STATUS,
            OP_LIST_AGENTS,
        ] {
            assert_eq!(timeout_for(op), READ_TIMEOUT, "{op} should answer fast");
        }
        assert_eq!(READ_TIMEOUT, Duration::from_secs(10));
        assert_eq!(ACTION_TIMEOUT, Duration::from_secs(150));
    }
}
