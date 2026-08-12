//! Control plane token registry.
//!
//! Every agent terminal gets its own token at spawn time, carrying the scope it
//! may act on and the capabilities it holds. This replaces the single global
//! token of `agent_events`, which cannot tell callers apart.
//!
//! Tokens live in memory only and are revoked when the PTY dies — a token that
//! outlived its terminal would grant a capability with no owner.
//!
//! Scope is validated by the FRONTEND, not here: `projects.json` is read from
//! disk with debounced writes, so a terminal created seconds ago does not yet
//! exist for the backend. This module answers "who is this and what may they
//! do", never "does that target belong to their group".

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// A single permission carried by a control token.
/// Wire values match the `ControlCapability` union in `src/lib/orchestrator/scope.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Capability {
    #[serde(rename = "terminal.list")]
    TerminalList,
    #[serde(rename = "terminal.read")]
    TerminalRead,
    #[serde(rename = "shell.run")]
    ShellRun,
    #[serde(rename = "events.read")]
    EventsRead,
    #[serde(rename = "agent.spawn")]
    AgentSpawn,
    #[serde(rename = "agent.prompt")]
    AgentPrompt,
    #[serde(rename = "agent.kill")]
    AgentKill,
}

/// Granted to every agent terminal.
const BASE_CAPABILITIES: [Capability; 4] = [
    Capability::TerminalList,
    Capability::TerminalRead,
    Capability::ShellRun,
    Capability::EventsRead,
];

/// Granted only to a terminal created with the orchestrator toggle on.
const ORCHESTRATOR_CAPABILITIES: [Capability; 3] = [
    Capability::AgentSpawn,
    Capability::AgentPrompt,
    Capability::AgentKill,
];

/// Agents spawned BY an orchestrator are minted with `orchestrator = false`, so
/// they never receive `agent.spawn`. The delegation tree is one level deep by
/// construction rather than by a runtime depth check.
pub fn capabilities_for(orchestrator: bool) -> BTreeSet<Capability> {
    let mut caps: BTreeSet<Capability> = BASE_CAPABILITIES.into_iter().collect();
    if orchestrator {
        caps.extend(ORCHESTRATOR_CAPABILITIES);
    }
    caps
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlToken {
    pub token: String,
    pub terminal_id: String,
    pub project_id: String,
    pub group_id: Option<String>,
    pub capabilities: BTreeSet<Capability>,
    pub issued_at_ms: u64,
}

impl ControlToken {
    pub fn allows(&self, capability: Capability) -> bool {
        self.capabilities.contains(&capability)
    }
}

fn registry() -> &'static Mutex<HashMap<String, ControlToken>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, ControlToken>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Length-aware constant-time compare, mirroring `remote::tokens_equal`.
/// Accumulates over every byte instead of returning early on the first mismatch.
fn tokens_equal(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= x ^ y;
    }
    diff == 0
}

/// Issues a token for a terminal, replacing any previous one it held.
///
/// Replacement matters on restart: a terminal that respawns must not leave its
/// old token usable.
pub fn mint(
    terminal_id: &str,
    project_id: &str,
    group_id: Option<String>,
    orchestrator: bool,
) -> ControlToken {
    let issued = ControlToken {
        token: nanoid::nanoid!(32),
        terminal_id: terminal_id.to_string(),
        project_id: project_id.to_string(),
        group_id,
        capabilities: capabilities_for(orchestrator),
        issued_at_ms: now_ms(),
    };
    let mut map = registry().lock().expect("control token registry poisoned");
    map.retain(|_, existing| existing.terminal_id != terminal_id);
    map.insert(issued.token.clone(), issued.clone());
    issued
}

/// Drops every token held by a terminal. Returns how many were dropped.
pub fn revoke(terminal_id: &str) -> usize {
    let mut map = registry().lock().expect("control token registry poisoned");
    let before = map.len();
    map.retain(|_, existing| existing.terminal_id != terminal_id);
    before - map.len()
}

/// What the frontend needs to hand a terminal so it can reach the control
/// plane: the secret, where to send it, and what it is allowed to ask for.
///
/// The scope (`terminal_id`, `project_id`, `group_id`) is deliberately absent —
/// the terminal learns its own identity from the server via `alethe_whoami`, so
/// there is one source of truth instead of two that can drift.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTokenInfo {
    pub token: String,
    pub endpoint: String,
    pub capabilities: BTreeSet<Capability>,
}

/// Issues a control token for a terminal and reports where to spend it.
///
/// The endpoint is resolved BEFORE minting: if the listener is not up yet, the
/// call fails without leaving a live token nobody can use.
#[tauri::command]
pub fn control_token_mint(
    terminal_id: String,
    project_id: String,
    group_id: Option<String>,
    orchestrator: bool,
) -> Result<ControlTokenInfo, String> {
    let endpoint = crate::agent_events::agent_hooks_endpoint()?;
    let issued = mint(&terminal_id, &project_id, group_id, orchestrator);
    Ok(ControlTokenInfo {
        token: issued.token,
        endpoint,
        capabilities: issued.capabilities,
    })
}

/// Drops every token held by a terminal. Returns how many were dropped, so the
/// caller can tell a real revocation from a no-op.
#[tauri::command]
pub fn control_token_revoke(terminal_id: String) -> Result<usize, String> {
    Ok(revoke(&terminal_id))
}

/// Resolves a presented token. Scans with a constant-time compare rather than a
/// hash lookup so a caller cannot learn a valid prefix from response timing;
/// the map holds one entry per live terminal, so the scan stays small.
pub fn resolve(presented: &str) -> Option<ControlToken> {
    if presented.is_empty() {
        return None;
    }
    let map = registry().lock().expect("control token registry poisoned");
    let mut found: Option<&ControlToken> = None;
    for (token, record) in map.iter() {
        if tokens_equal(token, presented) {
            found = Some(record);
        }
    }
    found.cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique(prefix: &str) -> String {
        format!("{prefix}-{}", nanoid::nanoid!(8))
    }

    #[test]
    fn plain_terminal_never_gets_orchestration() {
        let caps = capabilities_for(false);
        assert!(caps.contains(&Capability::ShellRun));
        assert!(caps.contains(&Capability::TerminalRead));
        assert!(!caps.contains(&Capability::AgentSpawn));
        assert!(!caps.contains(&Capability::AgentPrompt));
        assert!(!caps.contains(&Capability::AgentKill));
    }

    #[test]
    fn orchestrator_gets_both_tiers() {
        let caps = capabilities_for(true);
        assert!(caps.contains(&Capability::ShellRun));
        assert!(caps.contains(&Capability::AgentSpawn));
        assert_eq!(caps.len(), BASE_CAPABILITIES.len() + ORCHESTRATOR_CAPABILITIES.len());
    }

    #[test]
    fn resolves_a_minted_token_with_its_scope() {
        let terminal = unique("term");
        let issued = mint(&terminal, "proj-api", Some("grp-backend".into()), true);

        let resolved = resolve(&issued.token).expect("token should resolve");
        assert_eq!(resolved.terminal_id, terminal);
        assert_eq!(resolved.project_id, "proj-api");
        assert_eq!(resolved.group_id.as_deref(), Some("grp-backend"));
        assert!(resolved.allows(Capability::AgentSpawn));

        revoke(&terminal);
    }

    #[test]
    fn revoked_token_stops_resolving() {
        let terminal = unique("term");
        let issued = mint(&terminal, "proj-api", None, false);
        assert!(resolve(&issued.token).is_some());

        assert_eq!(revoke(&terminal), 1);
        assert!(resolve(&issued.token).is_none());
    }

    #[test]
    fn reminting_invalidates_the_previous_token() {
        // A terminal that respawns must not leave its old token usable.
        let terminal = unique("term");
        let first = mint(&terminal, "proj-api", None, false);
        let second = mint(&terminal, "proj-api", None, false);

        assert_ne!(first.token, second.token);
        assert!(resolve(&first.token).is_none());
        assert!(resolve(&second.token).is_some());

        revoke(&terminal);
    }

    #[test]
    fn rejects_empty_and_unknown_tokens() {
        assert!(resolve("").is_none());
        assert!(resolve("definitely-not-a-real-token").is_none());
    }

    #[test]
    fn tokens_of_different_length_never_match() {
        assert!(!tokens_equal("abc", "abcd"));
        assert!(!tokens_equal("abcd", "abc"));
        assert!(tokens_equal("abcd", "abcd"));
        assert!(!tokens_equal("abcd", "abce"));
    }

    #[test]
    fn capability_wire_values_match_the_frontend_union() {
        let encoded = serde_json::to_string(&capabilities_for(true)).expect("serializes");
        for expected in [
            "terminal.list",
            "terminal.read",
            "shell.run",
            "events.read",
            "agent.spawn",
            "agent.prompt",
            "agent.kill",
        ] {
            assert!(encoded.contains(expected), "missing {expected} in {encoded}");
        }
    }
}
