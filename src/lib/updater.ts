import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

/** Metadados de um update disponível, prontos pra exibir na UI. */
export type UpdateInfo = {
  version: string
  currentVersion: string
  /** Release notes (corpo do `latest.json`), se houver. */
  notes: string | null
  /** Data de publicação (string do manifesto), se houver. */
  date: string | null
}

export type UpdateProgress = { downloaded: number; total: number }

/** Handle do update pendente. Fica no módulo (não no store) porque é um objeto
 *  com métodos nativos — não dá pra serializar no Zustand nem no modalContext. */
let pending: Update | null = null

/**
 * Consulta o endpoint configurado (`plugins.updater.endpoints`) por uma versão
 * nova. Retorna `null` quando já está atualizado OU quando o updater não está
 * configurado/acessível (dev sem assinatura, offline, etc.) — nesses casos
 * `check()` lança e o chamador trata como "sem update", silenciosamente.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check()
  if (!update) {
    pending = null
    return null
  }
  pending = update
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? null,
    date: update.date ?? null,
  }
}

/**
 * Baixa e instala o update pendente e reinicia o app. Requer um `checkForUpdate`
 * prévio que tenha retornado um update. `onProgress` reporta bytes baixados.
 */
export async function installPendingUpdate(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<void> {
  if (!pending) throw new Error('Nenhum update pendente para instalar.')
  let total = 0
  let downloaded = 0
  await pending.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? 0
        onProgress?.({ downloaded: 0, total })
        break
      case 'Progress':
        downloaded += event.data.chunkLength
        onProgress?.({ downloaded, total })
        break
      case 'Finished':
        onProgress?.({ downloaded: total, total })
        break
    }
  })
  // Só chega aqui se o relaunch não tiver reiniciado o processo ainda.
  await relaunch()
}
