import { useState } from 'react'

import { GROUP_COLORS } from '../../lib/types'
import { useT } from '../../lib/i18n'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import { Modal } from './Modal'
import controls from './controls.module.css'

export function NewGroupModal() {
  const t = useT()
  const open = useUiStore((s) => s.openModal === 'newGroup')
  const context = useUiStore((s) => s.modalContext) as
    | { parentGroupId?: string | null }
    | null
  const parentGroupId = context?.parentGroupId ?? null
  const parentGroup = useProjectsStore((s) =>
    parentGroupId ? s.groups.find((g) => g.id === parentGroupId) ?? null : null,
  )
  const closeModal = useUiStore((s) => s.closeModal)
  const createGroup = useProjectsStore((s) => s.createGroup)

  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])

  const reset = () => {
    setName('')
    setColor(GROUP_COLORS[0])
  }

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    createGroup(trimmed, color, parentGroupId)
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
      title={parentGroup ? t('crud.newSubgroupTitle', { name: parentGroup.name }) : t('crud.newGroupTitle')}
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
          placeholder={t('crud.groupNamePlaceholder')}
        />
      </div>

      <div className={controls.field}>
        <label className={controls.label}>{t('crud.groupColorLabel')}</label>
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
    </Modal>
  )
}
