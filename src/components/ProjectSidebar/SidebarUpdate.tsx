import { ArrowUpCircle } from 'lucide-react'

import { useUiStore } from '../../stores/uiStore'
import { useT } from '../../lib/i18n'
import styles from './SidebarUpdate.module.css'

/**
 * Aviso discreto de atualização no rodapé da sidebar. Fica invisível quando o
 * app está atualizado (`updateInfo === null`, checado em silêncio no boot).
 * Quando há versão nova, mostra um chip leve — clicar abre o modal de update.
 */
export function SidebarUpdate() {
  const t = useT()
  const info = useUiStore((s) => s.updateInfo)
  const openModal = useUiStore((s) => s.openModal_)

  if (!info) return null

  return (
    <button
      type="button"
      className={styles.chip}
      onClick={() => openModal('updateAvailable')}
      title={t('update.chipTitle', { version: info.version })}
    >
      <ArrowUpCircle size={13} className={styles.icon} />
      <span className={styles.label}>{t('update.chipLabel')}</span>
      <span className={styles.version}>{info.version}</span>
    </button>
  )
}
