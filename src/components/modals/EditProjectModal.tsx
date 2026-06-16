import { useEffect, useState } from 'react'

import { GROUP_COLORS } from '../../lib/types'
import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { ImageInput } from './ImageInput'
import { Modal } from './Modal'
import controls from './controls.module.css'

export function EditProjectModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'editProject')
  const context = useUiStore((s) => s.modalContext) as { projectId?: string } | null
  const closeModal = useUiStore((s) => s.closeModal)
  const renameProject = useProjectsStore((s) => s.renameProject)
  const setProjectColor = useProjectsStore((s) => s.setProjectColor)
  const setProjectIconUrl = useProjectsStore((s) => s.setProjectIconUrl)
  const project = useProjectsStore((s) =>
    context?.projectId ? s.projects.find((p) => p.id === context.projectId) ?? null : null,
  )

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [iconUrl, setIconUrl] = useState('')

  useEffect(() => {
    if (open && project) {
      setName(project.name)
      setColor(project.color || GROUP_COLORS[0])
      setIconUrl(project.iconUrl ?? '')
    }
  }, [open, project])

  if (!project) return null

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== project.name) renameProject(project.id, trimmed)
    if (color !== project.color) setProjectColor(project.id, color)
    const trimmedUrl = iconUrl.trim()
    const newIconUrl = trimmedUrl || undefined
    if (newIconUrl !== project.iconUrl) setProjectIconUrl(project.id, newIconUrl)
    closeModal()
  }

  const previewIcon = iconUrl.trim()

  return (
    <Modal
      open={open}
      onClose={closeModal}
      title={t('crud.editProjectTitle')}
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
            {t('crud.save')}
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
        />
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.projectColorLabel')}</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {GROUP_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={t('crud.colorSwatch', { color: c })}
              style={{
                width: 28,
                height: 28,
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
        hint={t('crud.projectIconEditHint')}
      />

      <div
        style={{
          marginTop: 6,
          padding: '10px 12px',
          borderRadius: 'var(--radius-md)',
          border: `2px solid color-mix(in srgb, ${color} 50%, transparent)`,
          fontSize: 11,
          color: 'var(--fg-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {previewIcon ? (
          <img
            src={previewIcon}
            alt=""
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              objectFit: 'cover',
              flexShrink: 0,
            }}
          />
        ) : (
          <span
            style={{
              display: 'inline-block',
              width: 9,
              height: 9,
              borderRadius: 2,
              background: color,
              flexShrink: 0,
            }}
          />
        )}
        {t('crud.projectColorPreview')}
      </div>
    </Modal>
  )
}
