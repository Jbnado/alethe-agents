// Listener da POC do canvas de subagents (Fase 1).
//
// O Claude Code dispara hooks `SubagentStart`/`SubagentStop` como POST HTTP
// (hook type "http" no settings do projeto de teste). Este módulo sobe um
// servidor mínimo em 127.0.0.1:9123, lê o JSON de cada POST e re-emite pro
// frontend como evento Tauri `agent-hook`. Fluxo novo e isolado — não toca
// em PTY, projects nem em nenhum fluxo existente.

use std::io::Read;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9123;
const MAX_PORT: u16 = 9143;
const BODY_LIMIT: u64 = 1024 * 1024; // 1 MB
static LISTENER_PORT: AtomicU16 = AtomicU16::new(0);
static LISTENER_TOKEN: OnceLock<String> = OnceLock::new();

fn init_token() -> &'static str {
    LISTENER_TOKEN.get_or_init(|| nanoid::nanoid!(32))
}

fn check_token(request: &tiny_http::Request) -> bool {
    let expected = init_token();
    request
        .headers()
        .iter()
        .any(|h| h.field.as_str() == "X-Alethe-Token" && h.value.as_str() == expected)
}

fn listener_addr(port: u16) -> String {
    format!("{HOST}:{port}")
}

fn listener_endpoint(port: u16) -> String {
    format!("http://{HOST}:{port}")
}

fn current_listener_port() -> Option<u16> {
    let port = LISTENER_PORT.load(Ordering::SeqCst);
    (port != 0).then_some(port)
}

fn wait_for_listener_port() -> Option<u16> {
    let start = Instant::now();
    loop {
        if let Some(port) = current_listener_port() {
            return Some(port);
        }
        if start.elapsed() >= Duration::from_secs(2) {
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[tauri::command]
pub fn agent_hooks_endpoint() -> Result<String, String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    Ok(listener_endpoint(port))
}

#[tauri::command]
pub fn agent_hooks_token() -> String {
    init_token().to_string()
}

/// Escreve (idempotente) um settings JSON só com os hooks HTTP de subagent e
/// retorna o path. O frontend injeta via `claude --settings <path>` no
/// terminal do canvas — assim os hooks valem só pra ESSA sessão, sem tocar
/// no `.claude/` da pasta que o usuário escolheu.
#[tauri::command]
pub fn agent_hooks_settings_path() -> Result<String, String> {
    let port = wait_for_listener_port()
        .ok_or_else(|| "listener de agents ainda nao esta disponivel".to_string())?;
    let endpoint = listener_endpoint(port);
    let path = std::env::temp_dir().join("alethe-agent-hooks.json");
    let token = init_token();
    let hook = serde_json::json!([
        { "hooks": [ {
            "type": "http",
            "url": format!("{endpoint}/hook"),
            "timeout": 5,
            "headers": { "X-Alethe-Token": token }
        } ] }
    ]);
    let settings = serde_json::json!({
        // Fase 4: split-pane de teams não existe no Windows — in-process faz o
        // canvas do Alethe ser a visualização do time.
        "teammateMode": "in-process",
        "hooks": {
            "SubagentStart": hook.clone(),
            "SubagentStop": hook.clone(),
            // Fase 2: tool calls em tempo real. PreToolUse dentro de subagent
            // carrega agent_id (sessão principal não) — o store filtra por isso.
            "PreToolUse": hook.clone(),
            "PostToolUse": hook.clone(),
            // Fase 4: eventos de Agent Teams (in-process roda na sessão do
            // lead, então estes hooks via --settings pegam o time inteiro).
            "TeammateIdle": hook.clone(),
            "TaskCreated": hook.clone(),
            "TaskCompleted": hook
        }
    });
    let body = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    eprintln!(
        "[agent_events] hooks settings escrito em {}",
        path.display()
    );
    Ok(path.to_string_lossy().to_string())
}

pub fn start_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_error: Option<String> = None;
        let mut bound: Option<(tiny_http::Server, u16)> = None;

        for port in DEFAULT_PORT..=MAX_PORT {
            let addr = listener_addr(port);
            match tiny_http::Server::http(&addr) {
                Ok(server) => {
                    bound = Some((server, port));
                    break;
                }
                Err(e) => {
                    last_error = Some(format!("{addr}: {e}"));
                }
            }
        }

        let Some((server, port)) = bound else {
            eprintln!(
                "[agent_events] falha ao subir listener em {HOST}:{DEFAULT_PORT}-{MAX_PORT}: {}",
                last_error.unwrap_or_else(|| "sem erro detalhado".to_string())
            );
            return;
        };

        LISTENER_PORT.store(port, Ordering::SeqCst);
        eprintln!("[agent_events] ouvindo em {}", listener_addr(port));

        dispatch_concurrently(server.incoming_requests(), move |request| {
            handle_request(&app, request);
        });
    });
}

/// Hands every incoming item to `handler` on a dedicated thread.
///
/// Routes are allowed to block for a long time (a hook awaiting a human
/// approval in the UI can take minutes), so the accept loop must never wait for
/// a handler to finish — otherwise one pending request freezes the hooks of
/// every other terminal.
fn dispatch_concurrently<R, F>(requests: impl Iterator<Item = R>, handler: F)
where
    R: Send + 'static,
    F: Fn(R) + Send + Sync + 'static,
{
    let handler = Arc::new(handler);
    for request in requests {
        let handler = Arc::clone(&handler);
        std::thread::spawn(move || handler(request));
    }
}

/// Which authentication regime a request URL falls under.
#[derive(Debug, PartialEq, Eq)]
enum Route {
    /// MCP endpoint — per-terminal control token.
    Mcp,
    /// Reserved REST surface — per-terminal control token, not implemented yet.
    ReservedV1,
    /// Hook routes that predate the control plane — global listener token.
    Legacy,
}

fn route_of(url: &str) -> Route {
    let path = url.split(['?', '#']).next().unwrap_or("");
    if path == "/mcp" || path.starts_with("/mcp/") {
        Route::Mcp
    } else if path == "/v1" || path.starts_with("/v1/") {
        Route::ReservedV1
    } else {
        Route::Legacy
    }
}

/// Token check, body read and routing for a single request. Runs entirely off
/// the accept loop, so every blocking step (including reading the body from a
/// slow client) is isolated to this request.
fn handle_request(app: &AppHandle, mut request: tiny_http::Request) {
    let url = request.url().to_string();

    // Control-plane routes authenticate with a PER-TERMINAL token
    // (`control_api`), not with the single global token the legacy hook routes
    // share, so they are dispatched before `check_token` ever runs.
    match route_of(&url) {
        Route::Mcp => {
            crate::mcp_server::handle(app, request);
            return;
        }
        Route::ReservedV1 => {
            let body = serde_json::json!({
                "error": "not_implemented",
                "message": "the /v1 control API is reserved and not implemented yet",
            });
            let _ = request.respond(
                tiny_http::Response::from_string(body.to_string())
                    .with_status_code(501)
                    .with_header(
                        tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
                    ),
            );
            return;
        }
        Route::Legacy => {}
    }

    if !check_token(&request) {
        let _ = request.respond(tiny_http::Response::empty(401));
        return;
    }

    let mut body = String::new();
    if let Err(e) = request.as_reader().take(BODY_LIMIT).read_to_string(&mut body) {
        eprintln!("[agent_events] erro lendo corpo: {e}");
        let _ = request.respond(tiny_http::Response::empty(400));
        return;
    }

    // Ponte de dispatch genérica: o control plane (lead) spawna um
    // processo real (claude/codex/opencode) via
    // `curl -X POST /spawn -d '{"agent":"codex","task":"...","mode":"exec"}'`.
    // O Alethe emite `agent-spawn`; o front sobe um PTY worker. Campos:
    // agent (obrigatório), task, cwd?, mode? ("exec" default | "interactive").
    if url.starts_with("/spawn") {
        match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(payload) => {
                let agent = payload
                    .get("agent")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if !matches!(agent.as_str(), "shell" | "claude" | "codex" | "opencode") {
                    let _ = request.respond(tiny_http::Response::from_string(
                        "agent invalido (use claude|codex|opencode)",
                    ).with_status_code(400));
                    return;
                }
                let job_id = payload
                    .get("job_id")
                    .and_then(|value| value.as_str())
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("sandbox-job-{}", nanoid::nanoid!(10)));
                let mut event_payload = payload;
                if let Some(object) = event_payload.as_object_mut() {
                    object.insert("job_id".to_string(), serde_json::Value::String(job_id.clone()));
                }
                eprintln!("[agent_events] /spawn agent={agent} job_id={job_id}");
                let _ = app.emit("agent-spawn", &event_payload);
                let response = serde_json::json!({
                    "accepted": true,
                    "job_id": job_id,
                    "agent": agent,
                    "status": "queued"
                });
                let _ = request.respond(tiny_http::Response::from_string(response.to_string())
                    .with_header(tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap()));
            }
            Err(e) => {
                let _ = request.respond(tiny_http::Response::from_string(format!(
                    "/spawn espera JSON: {e}"
                )).with_status_code(400));
            }
        }
        return;
    }

    // Alias legado: o control plane antigo despacha texto cru pro codex
    // via `curl -X POST /codex -d '<tarefa>'`. Encaminha pro mesmo fluxo
    // emitindo agent-spawn com agent=codex.
    if url.starts_with("/codex") {
        let task = body.trim().to_string();
        eprintln!("[agent_events] /codex (legado) task ({} chars)", task.len());
        let payload = serde_json::json!({ "agent": "codex", "task": task });
        let _ = app.emit("agent-spawn", &payload);
        let _ = request.respond(tiny_http::Response::from_string(
            "queued no terminal codex do Alethe",
        ));
        return;
    }

    // Bridge do plugin OpenCode (opencode_bridge.rs) — reporta
    // working/idle real de sessoes OpenCode. Campos: directory
    // (cwd da sessao, usado pro front correlacionar com o ptyId certo),
    // state ("working" | "idle").
    if url.starts_with("/opencode-status") {
        match serde_json::from_str::<serde_json::Value>(&body) {
            Ok(payload) => {
                let _ = app.emit("opencode-bridge-status", &payload);
            }
            Err(e) => eprintln!("[agent_events] /opencode-status payload inválido: {e}"),
        }
        let _ = request.respond(tiny_http::Response::empty(200));
        return;
    }

    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(payload) => {
            let get = |k: &str| {
                payload
                    .get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or("?")
                    .to_owned()
            };
            eprintln!(
                "[agent_events] {} agent_id={} agent_type={}",
                get("hook_event_name"),
                get("agent_id"),
                get("agent_type"),
            );
            // Dump truncado pra inspecionar campos reais do payload
            // durante a POC (Etapa 0 do plano).
            let preview: String = body.chars().take(600).collect();
            eprintln!("[agent_events] payload: {preview}");
            if let Err(e) = app.emit("agent-hook", &payload) {
                eprintln!("[agent_events] falha ao emitir agent-hook: {e}");
            }
        }
        Err(e) => eprintln!("[agent_events] POST não-JSON ignorado: {e}"),
    }

    let _ = request.respond(tiny_http::Response::empty(200));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex};

    #[derive(Default)]
    struct Flight {
        in_flight: usize,
        peak: usize,
        finished: usize,
    }

    #[test]
    fn control_plane_routes_bypass_the_global_token() {
        assert_eq!(route_of("/mcp"), Route::Mcp);
        assert_eq!(route_of("/mcp?session=1"), Route::Mcp);
        assert_eq!(route_of("/mcp/"), Route::Mcp);
        assert_eq!(route_of("/v1"), Route::ReservedV1);
        assert_eq!(route_of("/v1/terminals"), Route::ReservedV1);
    }

    #[test]
    fn legacy_hook_routes_keep_the_global_token() {
        // The Agent Canvas depends on these; a prefix collision would silently
        // move them onto per-terminal auth and break every existing hook.
        for url in [
            "/hook",
            "/spawn",
            "/codex",
            "/opencode-status",
            "/",
            "/mcp-not-really",
            "/v1beta/anything",
        ] {
            assert_eq!(route_of(url), Route::Legacy, "{url} changed auth regime");
        }
    }

    /// Each handler parks until it sees another one in flight, so `peak` only
    /// reaches 2 if the dispatcher started the second request before the first
    /// returned. A serializing dispatcher makes both handlers time out alone
    /// and leaves `peak` at 1.
    #[test]
    fn dispatch_concurrently_does_not_serialize_handlers() {
        const REQUESTS: usize = 2;
        let state = Arc::new((Mutex::new(Flight::default()), Condvar::new()));

        let handler_state = Arc::clone(&state);
        dispatch_concurrently(0..REQUESTS, move |_request: usize| {
            let (lock, signal) = &*handler_state;
            let mut flight = lock.lock().unwrap();
            flight.in_flight += 1;
            flight.peak = flight.peak.max(flight.in_flight);
            signal.notify_all();
            let (mut flight, _) = signal
                .wait_timeout_while(flight, Duration::from_secs(1), |flight| {
                    flight.peak < REQUESTS
                })
                .unwrap();
            flight.in_flight -= 1;
            flight.finished += 1;
            signal.notify_all();
        });

        let (lock, signal) = &*state;
        let flight = lock.lock().unwrap();
        let (flight, wait) = signal
            .wait_timeout_while(flight, Duration::from_secs(10), |flight| {
                flight.finished < REQUESTS
            })
            .unwrap();
        assert!(!wait.timed_out(), "handlers never finished");
        assert_eq!(
            flight.peak, REQUESTS,
            "the dispatcher serialized requests: at most {} was ever in flight",
            flight.peak
        );
    }
}
