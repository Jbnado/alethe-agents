import { useProjectsStore } from '../../stores/projectsStore'
import { en, type MessageKey } from './messages/en'
import { ptBR } from './messages/pt-BR'

export type { MessageKey }

/** Idiomas suportados. `en` é o default e a fonte-de-verdade das chaves. */
export type Locale = 'en' | 'pt-BR'

export const DEFAULT_LOCALE: Locale = 'en'

export type LocaleMeta = {
  id: Locale
  /** Nome no próprio idioma, pra mostrar no seletor. */
  nativeName: string
  /** Locale BCP-47 pra Intl (datas/números). */
  intl: string
}

export const LOCALES: LocaleMeta[] = [
  { id: 'en', nativeName: 'English', intl: 'en-US' },
  { id: 'pt-BR', nativeName: 'Português', intl: 'pt-BR' },
]

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en,
  'pt-BR': ptBR,
}

export function intlLocale(locale: Locale): string {
  return LOCALES.find((l) => l.id === locale)?.intl ?? 'en-US'
}

type Params = Record<string, string | number>

function interpolate(message: string, params?: Params): string {
  if (!params) return message
  return message.replace(/\{(\w+)\}/g, (_, key: string) =>
    key in params ? String(params[key]) : `{${key}}`,
  )
}

/**
 * Tradução pura (sem hook). Usa o dicionário do `locale`, com fallback pra
 * `en` e, em último caso, pra própria chave. Interpola `{placeholder}`.
 */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const dict = DICTIONARIES[locale] ?? en
  const message = dict[key] ?? en[key] ?? key
  return interpolate(message, params)
}

/** Locale atual lido direto do store — pra uso fora de componentes React. */
export function getLocale(): Locale {
  return useProjectsStore.getState().preferences.language
}

export type TFunction = (key: MessageKey, params?: Params) => string

/**
 * Hook de tradução. Re-renderiza o componente quando o idioma muda.
 */
export function useT(): TFunction {
  const locale = useProjectsStore((s) => s.preferences.language)
  return (key, params) => translate(locale, key, params)
}
