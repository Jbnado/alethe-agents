import { ArrowLeftRight, Check, PencilLine, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { createProfile, deleteProfile, renameProfile, setActiveProfile } from '../../lib/tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'

export function ProfilesModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'profiles')
  const closeModal = useUiStore((s) => s.closeModal)
  const profiles = useProjectsStore((s) => s.profiles)
  const activeProfileId = useProjectsStore((s) => s.activeProfileId)

  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  useEffect(() => {
    if (open) return
    setNewName('')
    setEditingId(null)
    setEditingName('')
  }, [open])

  const sortedProfiles = useMemo(() => profiles, [profiles])
  const activeProfile = sortedProfiles.find((profile) => profile.id === activeProfileId) ?? null

  /** alinha ícone + texto dentro dos botões de ação. */
  const iconBtn = { display: 'inline-flex', alignItems: 'center', gap: 6 } as const

  const reload = () => window.location.reload()

  const create = async () => {
    const trimmed = newName.trim()
    if (!trimmed) {
      window.alert(t('profiles.nameRequired'))
      return
    }
    try {
      await createProfile(trimmed)
      reload()
    } catch (err) {
      window.alert(t('common.errorPrefix', { message: String(err) }))
    }
  }

  const switchProfile = async (profileId: string) => {
    if (profileId === activeProfileId) return
    try {
      await setActiveProfile(profileId)
      reload()
    } catch (err) {
      window.alert(t('common.errorPrefix', { message: String(err) }))
    }
  }

  const startRename = (profileId: string, currentName: string) => {
    setEditingId(profileId)
    setEditingName(currentName)
  }

  const saveRename = async () => {
    if (!editingId) return
    const trimmed = editingName.trim()
    if (!trimmed) {
      window.alert(t('profiles.nameRequired'))
      return
    }
    try {
      await renameProfile(editingId, trimmed)
      reload()
    } catch (err) {
      window.alert(t('common.errorPrefix', { message: String(err) }))
    }
  }

  const removeProfile = async (profileId: string) => {
    if (!window.confirm(t('profiles.deleteConfirm'))) return
    try {
      await deleteProfile(profileId)
      reload()
    } catch (err) {
      window.alert(t('common.errorPrefix', { message: String(err) }))
    }
  }

  return (
    <Modal open={open} onClose={closeModal} title={t('profiles.title')} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ color: 'var(--fg-muted)', fontSize: 12, lineHeight: 1.45 }}>
          {t('profiles.subtitle')}
        </div>

        <div className={controls.field}>
          <label className={controls.label}>{t('profiles.createTitle')}</label>
          <div className={controls.inputActionRow}>
            <input
              className={controls.input}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('profiles.createPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void create()
              }}
            />
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              style={iconBtn}
              onClick={() => void create()}
            >
              <Plus size={14} />
              <span>{t('profiles.createButton')}</span>
            </button>
          </div>
        </div>

        <div className={controls.field}>
          <label className={controls.label}>
            {t('profiles.current')}
            {activeProfile ? ` · ${activeProfile.name}` : ''}
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sortedProfiles.length === 0 ? (
              <div
                style={{
                  padding: '12px 14px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  background: 'var(--bg-sunken)',
                  color: 'var(--fg-muted)',
                  fontSize: 13,
                }}
              >
                {t('profiles.noProfiles')}
              </div>
            ) : (
              sortedProfiles.map((profile) => {
                const isActive = profile.id === activeProfileId
                const isEditing = editingId === profile.id
                return (
                  <div
                    key={profile.id}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-sunken)',
                      padding: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <strong style={{ fontSize: 14, color: 'var(--fg)' }}>{profile.name}</strong>
                          {isActive ? (
                            <span className={controls.pill} style={{ padding: '3px 8px', minHeight: 0 }}>
                              <Check size={12} />
                              {t('profiles.current')}
                            </span>
                          ) : null}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--fg-muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {profile.id}
                        </div>
                      </div>
                      {!isEditing ? (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <button
                            type="button"
                            className={controls.btn}
                            style={iconBtn}
                            onClick={() => void switchProfile(profile.id)}
                            disabled={isActive}
                          >
                            <ArrowLeftRight size={14} />
                            <span>{t('profiles.switchButton')}</span>
                          </button>
                          <button
                            type="button"
                            className={controls.btn}
                            style={iconBtn}
                            onClick={() => startRename(profile.id, profile.name)}
                          >
                            <PencilLine size={14} />
                            <span>{t('profiles.renameButton')}</span>
                          </button>
                          <button
                            type="button"
                            className={`${controls.btn} ${controls.btnDanger}`}
                            style={iconBtn}
                            onClick={() => void removeProfile(profile.id)}
                            disabled={profiles.length <= 1}
                          >
                            <Trash2 size={14} />
                            <span>{t('profiles.deleteButton')}</span>
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {isEditing ? (
                      <div className={controls.inputActionRow}>
                        <input
                          className={controls.input}
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          placeholder={t('profiles.renamePlaceholder')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void saveRename()
                            if (e.key === 'Escape') {
                              setEditingId(null)
                              setEditingName('')
                            }
                          }}
                          autoFocus
                        />
                        <button
                          type="button"
                          className={`${controls.btn} ${controls.btnPrimary}`}
                          style={iconBtn}
                          onClick={() => void saveRename()}
                        >
                          <Check size={14} />
                          <span>{t('common.save')}</span>
                        </button>
                        <button
                          type="button"
                          className={controls.btn}
                          onClick={() => {
                            setEditingId(null)
                            setEditingName('')
                          }}
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
