import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export async function loadProjectsFile(): Promise<string | null> {
  return invoke<string | null>('load_projects')
}

export async function saveProjectsFile(content: string): Promise<void> {
  await invoke('save_projects', { content })
}

export type ProfileMeta = {
  id: string
  name: string
  created_at_ms: number
  last_used_at_ms: number
}

export type ProfilesState = {
  active_profile_id: string
  profiles: ProfileMeta[]
}

export async function listProfiles(): Promise<ProfilesState> {
  return invoke<ProfilesState>('list_profiles')
}

export async function getActiveProfile(): Promise<ProfileMeta> {
  return invoke<ProfileMeta>('get_active_profile')
}

export async function setActiveProfile(profileId: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('set_active_profile', { profileId })
}

export async function createProfile(name?: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('create_profile', { name })
}

export async function renameProfile(profileId: string, name: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('rename_profile', { profileId, name })
}

export async function deleteProfile(profileId: string): Promise<ProfilesState> {
  return invoke<ProfilesState>('delete_profile', { profileId })
}

export type SpawnPtyArgs = {
  cols: number
  rows: number
  id?: string
  command?: string
  cwd?: string
  extraArgs?: string[]
  /** Path absoluto pro launcher (override do auto-detect). */
  launcherOverride?: string
  /** Env extra só deste PTY (não vaza pra outros terminais). */
  env?: Record<string, string>
}

export async function spawnPty(args: SpawnPtyArgs): Promise<{ id: string }> {
  return invoke<{ id: string }>('spawn_pty', {
    cols: args.cols,
    rows: args.rows,
    id: args.id,
    command: args.command,
    cwd: args.cwd,
    extraArgs: args.extraArgs,
    launcherOverride: args.launcherOverride,
    env: args.env,
  })
}

export async function attachPty(id: string, maxBytes = 512 * 1024): Promise<string> {
  return invoke<string>('attach_pty', { id, maxBytes })
}

export async function writePty(id: string, data: string): Promise<void> {
  await invoke('write_pty', { id, data })
}

export async function resizePty(id: string, cols: number, rows: number): Promise<void> {
  await invoke('resize_pty', { id, cols, rows })
}

export async function killPty(id: string): Promise<void> {
  await invoke('kill_pty', { id })
}

export async function restartPty(args: SpawnPtyArgs & { id: string }): Promise<{ id: string }> {
  return invoke<{ id: string }>('restart_pty', {
    id: args.id,
    command: args.command,
    cwd: args.cwd,
    extraArgs: args.extraArgs,
  })
}

export async function getPtyCwd(id: string): Promise<string | null> {
  return invoke<string | null>('get_pty_cwd', { id })
}

export function listenPtyData(
  id: string,
  handler: (chunk: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(`pty://data/${id}`, (event) => handler(event.payload))
}

export function listenPtyExit(
  id: string,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<{ code: number | null }>(`pty://exit/${id}`, (event) =>
    handler(event.payload.code),
  )
}

export type MemoryStats = {
  total_mb: number
  app_mb: number
  webview_mb: number
  ptys_mb: number
  process_count: number
}

export async function getMemoryStats(): Promise<MemoryStats> {
  return invoke<MemoryStats>('get_memory_stats')
}

export async function openDataFolder(): Promise<void> {
  await invoke('open_data_folder')
}

export async function openSpawnLog(): Promise<void> {
  await invoke('open_spawn_log')
}

export async function openInFileExplorer(path: string): Promise<void> {
  await invoke('open_in_file_explorer', { path })
}

export async function openInVscode(path: string): Promise<void> {
  await invoke('open_in_vscode', { path })
}

export async function openInBrowser(target: string): Promise<void> {
  await invoke('open_in_browser', { target })
}

export async function writeClipboardText(text: string): Promise<void> {
  await invoke('write_clipboard_text', { text })
}

export async function readClipboardText(): Promise<string> {
  return invoke<string>('read_clipboard_text')
}

export async function resetAppData(): Promise<void> {
  await invoke('reset_app_data')
}

export async function setDiscordPresence(
  details: string,
  state: string,
  startedAt: number,
): Promise<void> {
  await invoke('set_discord_presence', { details, state, startedAt })
}

export async function clearDiscordPresence(): Promise<void> {
  await invoke('clear_discord_presence')
}

export async function findCliLauncher(agent: string): Promise<string | null> {
  return invoke<string | null>('find_cli_launcher', { agent })
}

export async function exportBackup(targetPath: string): Promise<void> {
  await invoke('export_backup', { targetPath })
}

export async function importBackup(sourcePath: string): Promise<void> {
  await invoke('import_backup', { sourcePath })
}

export type ClaudeUsageWindow = {
  utilization: number
  resets_at: string
}

export type ClaudeUsage = {
  five_hour: ClaudeUsageWindow
  seven_day: ClaudeUsageWindow
  seven_day_opus: ClaudeUsageWindow
}

export async function getClaudeUsage(): Promise<ClaudeUsage> {
  return invoke<ClaudeUsage>('get_claude_usage')
}

export type ClaudeSessionMeta = {
  id: string
  title: string | null
  first_user_prompt: string | null
  message_count: number
  modified_at_ms: number
  size_bytes: number
}

export type ClaudeSessionSnapshot = {
  id: string
  modified_at_ms: number
  size_bytes: number
}

export type CodexSessionSnapshot = {
  id: string
  cwd: string
  modified_at_ms: number
  size_bytes: number
}

export async function snapshotClaudeSessions(cwd: string): Promise<ClaudeSessionSnapshot[]> {
  return invoke<ClaudeSessionSnapshot[]>('snapshot_claude_sessions', { cwd })
}

export async function snapshotCodexSessions(cwd: string): Promise<CodexSessionSnapshot[]> {
  return invoke<CodexSessionSnapshot[]>('snapshot_codex_sessions', { cwd })
}

export async function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>('list_claude_sessions', { cwd })
}

export type ActivityDay = {
  /** Data UTC YYYY-MM-DD */
  date: string
  /** Mensagens (user + assistant) registradas no dia */
  count: number
}

export async function getClaudeActivity(days: number): Promise<ActivityDay[]> {
  return invoke<ActivityDay[]>('get_claude_activity', { days })
}
