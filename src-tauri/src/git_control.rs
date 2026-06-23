use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    path: String,
    original_path: Option<String>,
    status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryStatus {
    repo_root: String,
    branch: String,
    detached: bool,
    ahead: u32,
    behind: u32,
    staged: Vec<GitFileChange>,
    changes: Vec<GitFileChange>,
    untracked: Vec<GitFileChange>,
    conflicts: Vec<GitFileChange>,
}

/// Aplica CREATE_NO_WINDOW no Windows pra que `git.exe` NÃO abra uma janela de
/// console a cada chamada. O GitControl faz polling de status a cada 3s (+ no
/// focus), então sem isso o usuário vê um festival de "terminais" piscando —
/// janelas de console abrindo e fechando sozinhas. No-op fora do Windows.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

fn git_command(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    hide_console(&mut command);
    command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("git_exec_failed:{error}")
        }
    })
}

fn push_if_dir(candidates: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() && !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn drive_roots() -> Vec<PathBuf> {
    ('A'..='Z')
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .filter(|path| path.is_dir())
        .collect()
}

fn resolve_input_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("directory_not_found".to_string());
    }

    let expanded = if trimmed == "~" {
        dirs_next::home_dir().unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        dirs_next::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(rest.replace('/', "\\"))
    } else {
        PathBuf::from(trimmed)
    };

    if expanded.is_dir() {
        return expanded
            .canonicalize()
            .map_err(|_| "directory_not_found".to_string());
    }

    let mut candidates = Vec::new();
    let looks_unix_root = trimmed.starts_with('/') && !trimmed.starts_with("//") && !trimmed.starts_with("/mnt/");
    if looks_unix_root {
        let relative = trimmed.trim_start_matches('/').replace('/', "\\");
        let username = dirs_next::home_dir()
            .and_then(|home| home.file_name().map(|name| name.to_string_lossy().into_owned()));
        for drive in drive_roots() {
            push_if_dir(&mut candidates, drive.join(&relative));
            if let Some(name) = username.as_deref() {
                push_if_dir(&mut candidates, drive.join(name).join(&relative));
                push_if_dir(&mut candidates, drive.join("Users").join(name).join(&relative));
            }
        }
    }

    candidates
        .into_iter()
        .next()
        .and_then(|candidate| candidate.canonicalize().ok())
        .ok_or_else(|| "directory_not_found".to_string())
}

fn checked_output(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let output = git_command(cwd, args)?;
    if output.status.success() {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "git_command_failed".to_string()
    } else {
        format!("git_command_failed:{stderr}")
    })
}

fn repository_root(path: &str) -> Result<PathBuf, String> {
    let cwd = resolve_input_directory(path)?;
    let output = git_command(&cwd, &["rev-parse", "--show-toplevel"])?;
    if !output.status.success() {
        return Err("not_a_git_repository".to_string());
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Err("not_a_git_repository".to_string());
    }
    PathBuf::from(root)
        .canonicalize()
        .map_err(|_| "not_a_git_repository".to_string())
}

fn validated_root(path: &str) -> Result<PathBuf, String> {
    let requested = resolve_input_directory(path).map_err(|_| "not_a_git_repository".to_string())?;
    let actual = repository_root(path)?;
    if requested != actual {
        return Err("invalid_repository_root".to_string());
    }
    Ok(actual)
}

fn validate_paths(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no_paths".to_string());
    }
    for path in paths {
        let parsed = Path::new(path);
        if parsed.is_absolute()
            || path.trim().is_empty()
            || parsed.components().any(|part| {
                matches!(
                    part,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err("invalid_git_path".to_string());
        }
    }
    Ok(())
}

fn run_path_command(root: &Path, args: &[&str], paths: &[String]) -> Result<(), String> {
    validate_paths(paths)?;
    let mut command = Command::new("git");
    command.current_dir(root).args(args).arg("--");
    for path in paths {
        command.arg(path);
    }
    hide_console(&mut command);
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("git_exec_failed:{error}")
        }
    })?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git_command_failed:{stderr}"))
    }
}

fn change(path: String, original_path: Option<String>, status: char) -> GitFileChange {
    GitFileChange {
        path,
        original_path,
        status: status.to_string(),
    }
}

fn is_conflict(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    )
}

fn parse_porcelain(
    output: &[u8],
) -> (
    Vec<GitFileChange>,
    Vec<GitFileChange>,
    Vec<GitFileChange>,
    Vec<GitFileChange>,
) {
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    let mut staged = Vec::new();
    let mut changes = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicts = Vec::new();
    let mut index = 0;

    while index < fields.len() {
        let field = fields[index];
        index += 1;
        if field.len() < 3 {
            continue;
        }
        let x = field[0] as char;
        let y = field[1] as char;
        let path = String::from_utf8_lossy(&field[3..]).into_owned();
        let renamed = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        let original_path = if renamed && index < fields.len() {
            let value = String::from_utf8_lossy(fields[index]).into_owned();
            index += 1;
            Some(value)
        } else {
            None
        };

        if x == '?' && y == '?' {
            untracked.push(change(path, None, '?'));
        } else if is_conflict(x, y) {
            conflicts.push(change(path, original_path, 'U'));
        } else {
            if x != ' ' {
                staged.push(change(path.clone(), original_path.clone(), x));
            }
            if y != ' ' {
                changes.push(change(path, original_path, y));
            }
        }
    }
    (staged, changes, untracked, conflicts)
}

fn branch_info(root: &Path) -> Result<(String, bool, u32, u32), String> {
    let symbolic = git_command(root, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let (branch, detached) = if symbolic.status.success() {
        (
            String::from_utf8_lossy(&symbolic.stdout).trim().to_string(),
            false,
        )
    } else {
        let short = checked_output(root, &["rev-parse", "--short", "HEAD"])
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_else(|_| "HEAD".to_string());
        (short, true)
    };

    let divergence = git_command(
        root,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )?;
    let (ahead, behind) = if divergence.status.success() {
        let values = String::from_utf8_lossy(&divergence.stdout)
            .split_whitespace()
            .filter_map(|value| value.parse::<u32>().ok())
            .collect::<Vec<_>>();
        (
            values.first().copied().unwrap_or(0),
            values.get(1).copied().unwrap_or(0),
        )
    } else {
        (0, 0)
    };
    Ok((branch, detached, ahead, behind))
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitRepositoryStatus, String> {
    let root = repository_root(&path)?;
    let status = checked_output(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let (staged, changes, untracked, conflicts) = parse_porcelain(&status.stdout);
    let (branch, detached, ahead, behind) = branch_info(&root)?;
    Ok(GitRepositoryStatus {
        repo_root: root.to_string_lossy().into_owned(),
        branch,
        detached,
        ahead,
        behind,
        staged,
        changes,
        untracked,
        conflicts,
    })
}

#[tauri::command]
pub fn git_stage(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    run_path_command(&root, &["add"], &paths)
}

#[tauri::command]
pub fn git_unstage(repo_root: String, paths: Vec<String>) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    let has_head = git_command(&root, &["rev-parse", "--verify", "HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false);
    if has_head {
        run_path_command(&root, &["restore", "--staged"], &paths)
            .or_else(|_| run_path_command(&root, &["reset", "HEAD"], &paths))
    } else {
        run_path_command(&root, &["rm", "-r", "--cached"], &paths)
    }
}

#[tauri::command]
pub fn git_discard(repo_root: String, paths: Vec<String>, untracked: bool) -> Result<(), String> {
    let root = validated_root(&repo_root)?;
    if untracked {
        run_path_command(&root, &["clean", "-fd"], &paths)
    } else {
        run_path_command(&root, &["restore", "--worktree"], &paths)
    }
}

#[tauri::command]
pub fn git_commit(repo_root: String, message: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("empty_commit_message".to_string());
    }
    let output = checked_output(&root, &["commit", "-m", trimmed])?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Comando git que fala com o remoto (push/pull). `GIT_TERMINAL_PROMPT=0` faz o
/// git FALHAR rápido em vez de TRAVAR esperando credenciais num prompt que não
/// existe (sem TTY no PTY oculto) — usa o credential helper / SSH agent já
/// configurados na máquina. stdout+stderr são combinados porque o git escreve o
/// progresso de rede no stderr mesmo em sucesso.
fn remote_command(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0");
    hide_console(&mut command);
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "git_not_found".to_string()
        } else {
            format!("git_exec_failed:{error}")
        }
    })?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(format!("{} {}", stdout.trim(), stderr.trim()).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git_command_failed:{stderr}"))
    }
}

#[tauri::command]
pub fn git_push(repo_root: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    match remote_command(&root, &["push"]) {
        // Branch sem upstream: publica em origin/<branch> (equivalente ao
        // "Publish Branch" do VSCode). Falha se o remoto não se chamar 'origin'.
        Err(error) if error.contains("no upstream") || error.contains("has no upstream") => {
            remote_command(&root, &["push", "--set-upstream", "origin", "HEAD"])
        }
        other => other,
    }
}

#[tauri::command]
pub fn git_pull(repo_root: String) -> Result<String, String> {
    let root = validated_root(&repo_root)?;
    // --ff-only evita merge commit/conflito surpresa: se a branch divergiu, erra
    // limpo em vez de criar um merge automático.
    remote_command(&root, &["pull", "--ff-only"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_staged_unstaged_untracked_conflict_and_rename() {
        let input = b"M  staged.txt\0 M changed file.txt\0?? new.txt\0UU conflict.txt\0R  renamed.txt\0old.txt\0";
        let (staged, changes, untracked, conflicts) = parse_porcelain(input);
        assert_eq!(staged.len(), 2);
        assert_eq!(staged[1].path, "renamed.txt");
        assert_eq!(staged[1].original_path.as_deref(), Some("old.txt"));
        assert_eq!(changes[0].path, "changed file.txt");
        assert_eq!(untracked[0].path, "new.txt");
        assert_eq!(conflicts[0].path, "conflict.txt");
    }

    #[test]
    fn keeps_both_sides_of_partially_staged_file() {
        let (staged, changes, _, _) = parse_porcelain(b"MM both.txt\0");
        assert_eq!(staged[0].path, "both.txt");
        assert_eq!(changes[0].path, "both.txt");
    }

    #[test]
    fn rejects_paths_outside_repository() {
        assert!(validate_paths(&["../secret".to_string()]).is_err());
        assert!(validate_paths(&["C:\\secret".to_string()]).is_err());
        assert!(validate_paths(&["src/main.rs".to_string()]).is_ok());
    }

    #[test]
    fn performs_stage_unstage_discard_and_commit() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("alethe-git-control-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let root_string = root.to_string_lossy().into_owned();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init"]);
        run(&["config", "user.name", "Alethe Test"]);
        run(&["config", "user.email", "alethe@example.invalid"]);

        fs::write(root.join("tracked.txt"), "one\n").unwrap();
        git_stage(root_string.clone(), vec!["tracked.txt".to_string()]).unwrap();
        assert_eq!(git_status(root_string.clone()).unwrap().staged.len(), 1);
        git_unstage(root_string.clone(), vec!["tracked.txt".to_string()]).unwrap();
        assert_eq!(git_status(root_string.clone()).unwrap().untracked.len(), 1);

        git_stage(root_string.clone(), vec!["tracked.txt".to_string()]).unwrap();
        git_commit(root_string.clone(), "initial".to_string()).unwrap();
        fs::write(root.join("tracked.txt"), "two\n").unwrap();
        assert_eq!(git_status(root_string.clone()).unwrap().changes.len(), 1);
        git_discard(root_string.clone(), vec!["tracked.txt".to_string()], false).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("tracked.txt")).unwrap().trim(),
            "one"
        );

        fs::write(root.join("untracked.txt"), "remove me\n").unwrap();
        git_discard(root_string, vec!["untracked.txt".to_string()], true).unwrap();
        assert!(!root.join("untracked.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
