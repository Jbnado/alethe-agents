import { useState } from 'react'

import { useUiStore } from '../../stores/uiStore'
import { useProjectsStore } from '../../stores/projectsStore'
import { GROUP_COLORS } from '../../lib/types'
import { useT } from '../../lib/i18n'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'
import controls from './controls.module.css'

export function NewProjectModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newProject')
  const context = useUiStore((s) => s.modalContext) as { groupId?: string | null } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const createProject = useProjectsStore((s) => s.createProject)
  const setActiveProject = useProjectsStore((s) => s.setActiveProject)
  const groups = useProjectsStore((s) => s.groups)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [iconUrl, setIconUrl] = useState('')
  const [groupId, setGroupId] = useState<string | null>(context?.groupId ?? null)

  const reset = () => {
    setName('')
    setColor(GROUP_COLORS[0])
    setIconUrl('')
    setGroupId(context?.groupId ?? null)
  }

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const project = createProject({ name: trimmed, color, iconUrl: iconUrl.trim() || undefined, groupId })
    setActiveProject(project.id)
    reset()
    closeModal()
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        closeModal()
      }}
      title={t('crud.newProjectTitle')}
      footer={
        <>
          <button type="button" className={controls.btn} onClick={closeModal}>
            {t('crud.cancel')}
          </button>
          <button
            type="button"
            className={`${controls.btn} ${controls.btnPrimary}`}
            disabled={!name.trim()}
            onClick={submit}
          >
            {t('crud.create')}
          </button>
        </>
      }
    >
      <div className={controls.field}>
        <label className={controls.label}>{t('crud.nameLabel')}</label>
        <input
          className={controls.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={t('crud.projectNamePlaceholder')}
        />
      </div>

      {groups.length > 0 ? (
        <div className={controls.field}>
          <label className={controls.label}>{t('crud.groupLabel')}</label>
          <select
            className={controls.input}
            value={groupId ?? ''}
            onChange={(e) => setGroupId(e.target.value || null)}
          >
            <option value="">{t('crud.noGroup')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.colorLabel')}</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={t('crud.colorSwatch', { color: c })}
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: c,
                border: color === c ? '2px solid var(--fg)' : '2px solid transparent',
                cursor: 'pointer',
              }}
            />
          ))}
        </div>
      </div>

      <ImageInput
        label={t('crud.iconLabel')}
        value={iconUrl}
        onChange={setIconUrl}
        onEnter={submit}
        hint={t('crud.projectIconHint')}
      />
    </Modal>
  )
}
