// Listener da POC do canvas de subagents (Fase 1).
//
// O Claude Code dispara hooks `SubagentStart`/`SubagentStop` como POST HTTP
// (hook type "http" no settings do projeto de teste). Este módulo sobe um
// servidor mínimo em 127.0.0.1:9123, lê o JSON de cada POST e re-emite pro
// frontend como evento Tauri `agent-hook`. Fluxo novo e isolado — não toca
// em PTY, projects nem em nenhum fluxo existente.

use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 9123;
const MAX_PORT: u16 = 9143;
static LISTENER_PORT: AtomicU16 = AtomicU16::new(0);

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
    let hook = serde_json::json!([
        { "hooks": [ { "type": "http", "url": format!("{endpoint}/hook"), "timeout": 5 } ] }
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

        for mut request in server.incoming_requests() {
            let url = request.url().to_string();
            let mut body = String::new();
            if let Err(e) = request.as_reader().read_to_string(&mut body) {
                eprintln!("[agent_events] erro lendo corpo: {e}");
                let _ = request.respond(tiny_http::Response::empty(400));
                continue;
            }

            // Ponte de controle: o control plane (lead) despacha uma tarefa pro
            // terminal codex via `curl -X POST /codex -d '<tarefa>'`. O Alethe
            // emite `codex-task`; o front escreve no PTY do codex worker. Body
            // é texto cru (a tarefa), não JSON.
            if url.starts_with("/codex") {
                let task = body.trim().to_string();
                eprintln!("[agent_events] /codex task ({} chars)", task.len());
                let _ = app.emit("codex-task", &task);
                let _ = request.respond(tiny_http::Response::from_string(
                    "queued no terminal codex do Alethe",
                ));
                continue;
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
    });
}
