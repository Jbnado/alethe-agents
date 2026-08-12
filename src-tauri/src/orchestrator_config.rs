//! MCP wiring for orchestrator terminals, one shape per CLI.
//!
//! A terminal created with the orchestrator toggle on reaches Alethe's own MCP
//! server (`mcp_server.rs`, served by the `agent_events` listener at `/mcp`)
//! using the control token minted for it in `control_api.rs`. Each CLI takes a
//! different route, and the differences are not cosmetic:
//!
//! - **Claude Code** accepts `--mcp-config <path>` (repeatable) and arbitrary
//!   headers, so the token travels in an `Authorization` header inside a
//!   temporary JSON file. This mirrors `ai_memory::ai_memory_mcp_config_path`
//!   so the two servers coexist instead of overwriting each other.
//! - **Codex** accepts no arbitrary headers — the only supported form is
//!   `bearer_token_env_var`, which names an environment variable the CLI reads
//!   the token from. It is therefore configured entirely through `-c` overrides
//!   and **nothing is written to disk**: the token only ever exists in the PTY's
//!   own environment, never in a file and never in the process command line.
//!
//! Codex is deliberately NOT given an isolated `CODEX_HOME`: `auth.json` lives
//! there, and pointing it elsewhere breaks authentication outright.
//!
//! Scope note: the Claude config file is written under the OS temp dir and
//! carries a live bearer token, exactly like the settings file
//! `agent_events::agent_hooks_settings_path` already writes. The token is
//! in-memory only and dies with its terminal (see `control_api::revoke`), so a
//! leftover file grants nothing once the terminal is gone.

use serde::Serialize;
use serde_json::Value;

/// Key the Alethe MCP server is registered under in every agent config.
pub const MCP_KEY: &str = "alethe";

/// Environment variable carrying the control token into the spawned CLI.
/// Shared between the PTY env and the Codex `bearer_token_env_var` override,
/// so the two can never drift apart.
pub const TOKEN_ENV_VAR: &str = "ALETHE_TOKEN";

fn short_hash(input: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// Resolves the MCP endpoint from the listener endpoint reported by
/// `control_token_mint`. Tolerates a trailing slash so callers never have to
/// normalize it themselves.
pub fn mcp_url(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("empty_endpoint".to_string());
    }
    Ok(format!("{trimmed}/mcp"))
}

/// The `--mcp-config` document for Claude Code: streamable HTTP transport plus
/// the bearer header, which is the only CLI of the two that accepts headers.
pub fn claude_mcp_config(endpoint: &str, token: &str) -> Result<Value, String> {
    let url = mcp_url(endpoint)?;
    if token.trim().is_empty() {
        return Err("empty_token".to_string());
    }
    Ok(serde_json::json!({
        // Dynamic key inside `json!` has to be parenthesized.
        "mcpServers": {
            (MCP_KEY): {
                "type": "http",
                "url": url,
                "headers": { "Authorization": format!("Bearer {token}") }
            }
        }
    }))
}

/// Writes the Claude MCP config for one terminal and returns its path, for the
/// frontend to pass as `--mcp-config <path>`.
///
/// The file name is derived from `terminal_id`: every terminal holds a distinct
/// token, so a shared file would have one terminal's launch overwrite another's
/// credential mid-spawn.
#[tauri::command]
pub fn orchestrator_claude_mcp_config_path(
    terminal_id: String,
    endpoint: String,
    token: String,
) -> Result<String, String> {
    let config = claude_mcp_config(&endpoint, &token)?;
    let file_name = format!("alethe-orchestrator-mcp-{}.json", short_hash(&terminal_id));
    let path = std::env::temp_dir().join(file_name);
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// The `-c` override registering the Alethe MCP server for Codex. The token is
/// referenced by env var name, never inlined — a command line is readable by
/// every process on the machine.
pub fn codex_config_override(endpoint: &str) -> Result<String, String> {
    let url = mcp_url(endpoint)?;
    let value = serde_json::to_string(&serde_json::json!({
        "url": url,
        "bearer_token_env_var": TOKEN_ENV_VAR,
    }))
    .map_err(|e| e.to_string())?;
    Ok(format!("mcp_servers.{MCP_KEY}={value}"))
}

/// Leading CLI arguments for a Codex orchestrator terminal.
///
/// `--ignore-user-config` is what the verified spike used, and it is why this
/// whole path is opt-in per terminal: it discards `~/.codex/config.toml`, so
/// applying it to an ordinary Codex terminal would silently drop the user's own
/// model, provider and MCP settings.
pub fn codex_launch_args(endpoint: &str) -> Result<Vec<String>, String> {
    Ok(vec![
        "--ignore-user-config".to_string(),
        "-c".to_string(),
        codex_config_override(endpoint)?,
    ])
}

/// What the frontend needs to launch Codex against the control plane: the
/// leading arguments and the environment variable the token must be exported
/// under. Nothing is written to disk for this CLI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOrchestratorLaunch {
    pub args: Vec<String>,
    pub token_env_var: String,
}

#[tauri::command]
pub fn orchestrator_codex_launch(endpoint: String) -> Result<CodexOrchestratorLaunch, String> {
    Ok(CodexOrchestratorLaunch {
        args: codex_launch_args(&endpoint)?,
        token_env_var: TOKEN_ENV_VAR.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_the_mcp_route_to_the_listener_endpoint() {
        assert_eq!(mcp_url("http://127.0.0.1:9123").unwrap(), "http://127.0.0.1:9123/mcp");
        assert_eq!(mcp_url("http://127.0.0.1:9123/").unwrap(), "http://127.0.0.1:9123/mcp");
        assert_eq!(mcp_url("  http://127.0.0.1:9123  ").unwrap(), "http://127.0.0.1:9123/mcp");
    }

    #[test]
    fn refuses_an_endpoint_that_carries_no_address() {
        assert!(mcp_url("").is_err());
        assert!(mcp_url("   ").is_err());
        assert!(mcp_url("/").is_err());
    }

    #[test]
    fn claude_config_carries_the_bearer_header() {
        let config = claude_mcp_config("http://127.0.0.1:9123", "tok_abc").unwrap();
        let server = &config["mcpServers"][MCP_KEY];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], "http://127.0.0.1:9123/mcp");
        assert_eq!(server["headers"]["Authorization"], "Bearer tok_abc");
    }

    #[test]
    fn claude_config_refuses_an_empty_token() {
        // A config without a credential would make Claude fail every call
        // against a 401 instead of simply starting without the server.
        assert!(claude_mcp_config("http://127.0.0.1:9123", "").is_err());
        assert!(claude_mcp_config("http://127.0.0.1:9123", "   ").is_err());
    }

    #[test]
    fn writes_a_readable_config_file_per_terminal() {
        let first =
            orchestrator_claude_mcp_config_path("term-a".into(), "http://127.0.0.1:9123".into(), "tok_a".into())
                .expect("writes");
        let second =
            orchestrator_claude_mcp_config_path("term-b".into(), "http://127.0.0.1:9123".into(), "tok_b".into())
                .expect("writes");
        assert_ne!(first, second, "each terminal needs its own file");

        let raw = std::fs::read_to_string(&first).expect("reads back");
        let parsed: Value = serde_json::from_str(&raw).expect("valid json");
        assert_eq!(parsed["mcpServers"][MCP_KEY]["headers"]["Authorization"], "Bearer tok_a");

        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }

    #[test]
    fn rewriting_a_terminal_config_replaces_the_previous_token() {
        // A terminal that respawns mints a new token; the stale one must not
        // survive in the file the CLI reads.
        let path =
            orchestrator_claude_mcp_config_path("term-c".into(), "http://127.0.0.1:9123".into(), "tok_old".into())
                .expect("writes");
        let again =
            orchestrator_claude_mcp_config_path("term-c".into(), "http://127.0.0.1:9123".into(), "tok_new".into())
                .expect("writes");
        assert_eq!(path, again);

        let raw = std::fs::read_to_string(&path).expect("reads back");
        assert!(raw.contains("Bearer tok_new"));
        assert!(!raw.contains("tok_old"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn codex_override_names_the_env_var_instead_of_inlining_the_token() {
        let raw = codex_config_override("http://127.0.0.1:9123").unwrap();
        let (key, value) = raw.split_once('=').expect("key=value");
        assert_eq!(key, "mcp_servers.alethe");

        let parsed: Value = serde_json::from_str(value).expect("valid json value");
        assert_eq!(parsed["url"], "http://127.0.0.1:9123/mcp");
        assert_eq!(parsed["bearer_token_env_var"], TOKEN_ENV_VAR);
    }

    #[test]
    fn codex_launch_ignores_the_user_config_and_reports_the_env_var() {
        let launch = orchestrator_codex_launch("http://127.0.0.1:9123".into()).unwrap();
        assert_eq!(launch.token_env_var, TOKEN_ENV_VAR);
        assert_eq!(launch.args[0], "--ignore-user-config");
        assert_eq!(launch.args[1], "-c");
        assert!(launch.args[2].starts_with("mcp_servers.alethe="));
        // Nothing else may be added: these three flags must stay ahead of any
        // subcommand the launch builder puts after them.
        assert_eq!(launch.args.len(), 3);
    }

    #[test]
    fn codex_launch_fails_without_a_listener() {
        assert!(orchestrator_codex_launch(String::new()).is_err());
    }
}
