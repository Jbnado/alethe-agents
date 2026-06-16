import { getLocale, translate, type MessageKey, type TFunction } from './i18n'
import type { Theme } from './types'

export type ThemeOption = {
  id: Theme
  colors: [string, string, string]
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'dark', colors: ['#101114', '#2a2d33', '#f3f4f6'] },
  { id: 'light', colors: ['#f6f7fb', '#ffffff', '#18181b'] },
  { id: 'dracula', colors: ['#282a36', '#bd93f9', '#ff79c6'] },
  { id: 'nord', colors: ['#2e3440', '#88c0d0', '#a3be8c'] },
  { id: 'gruvbox', colors: ['#282828', '#fabd2f', '#b8bb26'] },
  { id: 'solarized', colors: ['#002b36', '#268bd2', '#b58900'] },
  { id: 'tokyo-night', colors: ['#1a1b26', '#7aa2f7', '#bb9af7'] },
  { id: 'vscode', colors: ['#1e1e1e', '#007acc', '#cccccc'] },
  { id: 'min-dark', colors: ['#1f1f1f', '#fafafa', '#888888'] },
  { id: 'min-light', colors: ['#ffffff', '#1976D2', '#6f42c1'] },
  { id: 'dark-lemon', colors: ['#141414', '#ffff50', '#c792ea'] },
]

/** Label localizado do tema (uso em componentes React, via `t`). */
export function themeLabel(t: TFunction, id: Theme): string {
  return t(`theme.${id}.label` as MessageKey)
}

/** Descrição localizada do tema (uso em componentes React, via `t`). */
export function themeDescription(t: TFunction, id: Theme): string {
  return t(`theme.${id}.desc` as MessageKey)
}

/** Label localizado do tema fora de React (lê o locale atual do store). */
export function getThemeLabel(id: Theme): string {
  return translate(getLocale(), `theme.${id}.label` as MessageKey)
}
