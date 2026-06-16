import * as Dialog from '@radix-ui/react-dialog'
import { Minus, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { autoGridLayout, reconcileGridLayout } from '../../lib/gridLayout'
import { useT } from '../../lib/i18n'
import type { GridCell, GridLayout } from '../../lib/types'
import { useProjectsStore } from '../../stores/projectsStore'
import { useUiStore } from '../../stores/uiStore'
import controls from './controls.module.css'
import styles from './LayoutDesignerModal.module.css'

type DesignerChild = {
  id: string
  label: string
  color?: string
  /** Texto secundário pequeno (cwd, type, etc). */
  hint?: string
}

type Context =
  | { kind: 'project'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'workspace' }

export function LayoutDesignerModal() {
  const open = useUiStore((s) => s.openModal === 'layoutDesigner')
  const context = useUiStore((s) => s.modalContext) as Context | null
  const closeModal = useUiStore((s) => s.closeModal)

  if (!open || !context) return null
  const k = context.kind === 'workspace' ? 'workspace' : `${context.kind}:${context.id}`
  return <DesignerInner key={k} context={context} onClose={closeModal} />
}

function DesignerInner({ context, onClose }: { context: Context; onClose: () => void }) {
  const t = useT()
  const project = useProjectsStore((s) =>
    context.kind === 'project' ? s.projects.find((p) => p.id === context.id) : null,
  )
  const group = useProjectsStore((s) =>
    context.kind === 'group' ? s.groups.find((g) => g.id === context.id) : null,
  )
  const projects = useProjectsStore((s) => s.projects)
  const containers = useProjectsStore((s) => s.workspace.containers)
  const workspaceLayout = useProjectsStore((s) => s.preferences.workspaceGridLayout)
  const setProjectGridLayout = useProjectsStore((s) => s.setProjectGridLayout)
  const setGroupGridLayout = useProjectsStore((s) => s.setGroupGridLayout)
  const setWorkspaceGridLayout = useProjectsStore((s) => s.setWorkspaceGridLayout)

  const [title, children, currentLayout] = useMemo<
    [string, DesignerChild[], GridLayout | undefined]
  >(() => {
    if (context.kind === 'project' && project) {
      return [
        t('mod.layoutTitleProject', { name: project.name }),
        project.terminals.map((term) => ({
          id: term.id,
          label: term.name,
          color: project.color,
          hint: term.tabs[0]?.type ?? 'shell',
        })),
        project.gridLayout,
      ]
    }
    if (context.kind === 'group' && group) {
      const groupProjects = group.projectIds
        .map((id) => projects.find((p) => p.id === id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
      return [
        t('mod.layoutTitleGroup', { name: group.name }),
        groupProjects.map((p) => ({
          id: p.id,
          label: p.name,
          color: p.color,
          hint: t('mod.terminalCount', { count: p.terminals.length }),
        })),
        group.gridLayout,
      ]
    }
    if (context.kind === 'workspace') {
      const openProjects = containers
        .map((c) => projects.find((p) => p.id === c.projectId))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
      return [
        t('mod.layoutTitleWorkspace'),
        openProjects.map((p) => ({
          id: p.id,
          label: p.name,
          color: p.color,
          hint: t('mod.terminalCount', { count: p.terminals.length }),
        })),
        workspaceLayout,
      ]
    }
    return [t('mod.layoutTitleFallback'), [], undefined]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context, project, group, projects, containers, workspaceLayout])

  const childIds = children.map((c) => c.id)

  const initialLayout = useMemo<GridLayout>(() => {
    if (currentLayout) return reconcileGridLayout(currentLayout, childIds)
    return autoGridLayout(childIds, 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [cols, setCols] = useState(initialLayout.cols)
  const [rows, setRows] = useState(initialLayout.rows)
  const [cells, setCells] = useState<Record<string, GridCell>>(initialLayout.cells)
  const [colSizes, setColSizes] = useState<number[]>(
    initialLayout.colSizes && initialLayout.colSizes.length === initialLayout.cols
      ? initialLayout.colSizes
      : Array(initialLayout.cols).fill(1),
  )
  const [rowSizes, setRowSizes] = useState<number[]>(
    initialLayout.rowSizes && initialLayout.rowSizes.length === initialLayout.rows
      ? initialLayout.rowSizes
      : Array(initialLayout.rows).fill(1),
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)

  // mantém o grid coerente quando muda cols/rows: clamp + resolve overlaps
  // movendo cells colidentes pra próxima célula livre.
  useEffect(() => {
    setCells((prev) => {
      const ids = Object.keys(prev)
      const next: Record<string, GridCell> = {}
      const occupied = new Set<string>()

      const overlaps = (col: number, row: number, colSpan: number, rowSpan: number) => {
        for (let r = row; r < row + rowSpan; r++) {
          for (let c = col; c < col + colSpan; c++) {
            if (occupied.has(`${r}:${c}`)) return true
          }
        }
        return false
      }
      const occupy = (col: number, row: number, colSpan: number, rowSpan: number) => {
        for (let r = row; r < row + rowSpan; r++) {
          for (let c = col; c < col + colSpan; c++) {
            occupied.add(`${r}:${c}`)
          }
        }
      }
      const findFreeSpot = (colSpan: number, rowSpan: number) => {
        for (let r = 1; r <= rows - rowSpan + 1; r++) {
          for (let c = 1; c <= cols - colSpan + 1; c++) {
            if (!overlaps(c, r, colSpan, rowSpan)) return { col: c, row: r }
          }
        }
        // sem espaço pra esse span — força span 1x1 e busca de novo
        for (let r = 1; r <= rows; r++) {
          for (let c = 1; c <= cols; c++) {
            if (!occupied.has(`${r}:${c}`)) return { col: c, row: r }
          }
        }
        return { col: 1, row: 1 }
      }

      for (const id of ids) {
        const cell = prev[id]
        const colSpan = Math.max(1, Math.min(cols, cell.colSpan))
        const rowSpan = Math.max(1, Math.min(rows, cell.rowSpan))
        const col = Math.max(1, Math.min(cols - colSpan + 1, cell.col))
        const row = Math.max(1, Math.min(rows - rowSpan + 1, cell.row))
        if (!overlaps(col, row, colSpan, rowSpan)) {
          next[id] = { col, row, colSpan, rowSpan }
          occupy(col, row, colSpan, rowSpan)
        } else {
          // tenta manter o span; se não couber, reduz pra 1x1
          let spot = findFreeSpot(colSpan, rowSpan)
          let finalColSpan = colSpan
          let finalRowSpan = rowSpan
          if (overlaps(spot.col, spot.row, finalColSpan, finalRowSpan)) {
            finalColSpan = 1
            finalRowSpan = 1
            spot = findFreeSpot(1, 1)
          }
          next[id] = {
            col: spot.col,
            row: spot.row,
            colSpan: finalColSpan,
            rowSpan: finalRowSpan,
          }
          occupy(spot.col, spot.row, finalColSpan, finalRowSpan)
        }
      }
      return next
    })
    setColSizes((prev) => {
      if (prev.length === cols) return prev
      if (prev.length < cols) return [...prev, ...Array(cols - prev.length).fill(1)]
      return prev.slice(0, cols)
    })
    setRowSizes((prev) => {
      if (prev.length === rows) return prev
      if (prev.length < rows) return [...prev, ...Array(rows - prev.length).fill(1)]
      return prev.slice(0, rows)
    })
  }, [cols, rows])

  const dropAt = (id: string, col: number, row: number) => {
    setCells((prev) => {
      const cur = prev[id]
      if (!cur) return prev
      const colSpan = Math.min(cur.colSpan, cols - col + 1)
      const rowSpan = Math.min(cur.rowSpan, rows - row + 1)
      // swap com qualquer filho ocupando a célula destino
      const occupant = Object.entries(prev).find(([oid, c]) => {
        if (oid === id) return false
        return (
          col < c.col + c.colSpan &&
          col + colSpan > c.col &&
          row < c.row + c.rowSpan &&
          row + rowSpan > c.row
        )
      })
      const next: Record<string, GridCell> = { ...prev }
      next[id] = { col, row, colSpan, rowSpan }
      if (occupant) {
        const [otherId] = occupant
        next[otherId] = {
          col: cur.col,
          row: cur.row,
          colSpan: cur.colSpan,
          rowSpan: cur.rowSpan,
        }
      }
      return next
    })
  }

  /** Pointer-based drag — substitui HTML5 drag que falha quando o source box
      cobre seu próprio drop slot. Detecta drop pela coord do pointer. */
  const startDrag = (id: string, e: React.PointerEvent) => {
    // ignora se o user clicou no resize handle (handle pega o evento via stopPropagation)
    if ((e.target as HTMLElement).closest('[data-resize-handle="1"]')) return
    e.preventDefault()
    setDragging(id)
    setSelected(id)
    const onMove = (ev: PointerEvent) => {
      ev.preventDefault()
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const target = pixelToCell(ev.clientX, ev.clientY)
      // só dropa se o cursor terminou DENTRO do canvas
      const el = canvasRef.current
      if (el) {
        const rect = el.getBoundingClientRect()
        const inside =
          ev.clientX >= rect.left &&
          ev.clientX <= rect.right &&
          ev.clientY >= rect.top &&
          ev.clientY <= rect.bottom
        if (inside) dropAt(id, target.col, target.row)
      }
      setDragging(null)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
  }

  /** Mapeia coordenada de pixel pra célula (col/row 1-based) usando os pesos atuais. */
  const pixelToCell = (clientX: number, clientY: number): { col: number; row: number } => {
    const el = canvasRef.current
    if (!el) return { col: 1, row: 1 }
    const rect = el.getBoundingClientRect()
    const totalCol = colSizes.reduce((a, b) => a + b, 0) || 1
    const totalRow = rowSizes.reduce((a, b) => a + b, 0) || 1
    const xFrac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const yFrac = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    let acc = 0
    let col = cols
    for (let i = 0; i < cols; i++) {
      acc += colSizes[i] / totalCol
      if (xFrac <= acc) {
        col = i + 1
        break
      }
    }
    acc = 0
    let row = rows
    for (let i = 0; i < rows; i++) {
      acc += rowSizes[i] / totalRow
      if (yFrac <= acc) {
        row = i + 1
        break
      }
    }
    return { col, row }
  }

  const startResize = (id: string, e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const cur = cells[id]
    if (!cur) return
    const onMove = (ev: PointerEvent) => {
      const target = pixelToCell(ev.clientX, ev.clientY)
      const colSpan = Math.max(1, Math.min(cols - cur.col + 1, target.col - cur.col + 1))
      const rowSpan = Math.max(1, Math.min(rows - cur.row + 1, target.row - cur.row + 1))
      setCells((prev) => {
        const c = prev[id]
        if (!c) return prev
        if (c.colSpan === colSpan && c.rowSpan === rowSpan) return prev
        return { ...prev, [id]: { ...c, colSpan, rowSpan } }
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Drag entre 2 colunas pra ajustar fração (em fr). */
  const startColResize = (colIdx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const el = canvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const initialSizes = [...colSizes]
    const total = initialSizes.reduce((a, b) => a + b, 0)
    const onMove = (ev: PointerEvent) => {
      const xFrac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
      // soma dos frações até `colIdx` exclusive
      let before = 0
      for (let i = 0; i < colIdx; i++) before += initialSizes[i] / total
      // tamanho combinado das duas cols envolvidas (colIdx-1 e colIdx)
      const combinedFrac = (initialSizes[colIdx - 1] + initialSizes[colIdx]) / total
      const leftFrac = Math.max(0.05, Math.min(combinedFrac - 0.05, xFrac - before))
      const rightFrac = combinedFrac - leftFrac
      const next = [...initialSizes]
      next[colIdx - 1] = leftFrac * total
      next[colIdx] = rightFrac * total
      setColSizes(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const startRowResize = (rowIdx: number, e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const el = canvasRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const initialSizes = [...rowSizes]
    const total = initialSizes.reduce((a, b) => a + b, 0)
    const onMove = (ev: PointerEvent) => {
      const yFrac = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
      let before = 0
      for (let i = 0; i < rowIdx; i++) before += initialSizes[i] / total
      const combinedFrac = (initialSizes[rowIdx - 1] + initialSizes[rowIdx]) / total
      const topFrac = Math.max(0.05, Math.min(combinedFrac - 0.05, yFrac - before))
      const bottomFrac = combinedFrac - topFrac
      const next = [...initialSizes]
      next[rowIdx - 1] = topFrac * total
      next[rowIdx] = bottomFrac * total
      setRowSizes(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const resetAuto = () => {
    const auto = autoGridLayout(childIds, cols)
    setCells(auto.cells)
    setRows(auto.rows)
    setColSizes(Array(cols).fill(1))
    setRowSizes(Array(auto.rows).fill(1))
  }

  const save = () => {
    const layout = reconcileGridLayout({
      cols,
      rows,
      cells,
      colSizes: colSizes.length === cols ? colSizes : undefined,
      rowSizes: rowSizes.length === rows ? rowSizes : undefined,
    }, childIds)
    if (context.kind === 'project') setProjectGridLayout(context.id, layout)
    else if (context.kind === 'group') setGroupGridLayout(context.id, layout)
    else setWorkspaceGridLayout(layout)
    onClose()
  }

  const clearWorkspace =
    context.kind === 'workspace' && workspaceLayout
      ? () => {
          setWorkspaceGridLayout(null)
          onClose()
        }
      : null

  const cellsArray = Array.from({ length: cols * rows }, (_, i) => ({
    col: (i % cols) + 1,
    row: Math.floor(i / cols) + 1,
  }))

  return (
    <Dialog.Root open onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          className={styles.content}
          aria-describedby={undefined}
          onEscapeKeyDown={onClose}
        >
          <header className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <button
              type="button"
              className={styles.closeBtn}
              aria-label={t('mod.close')}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </header>

          <div className={styles.toolbar}>
            <Stepper
              label="cols"
              value={cols}
              onDec={() => setCols((v) => Math.max(1, v - 1))}
              onInc={() => setCols((v) => Math.min(8, v + 1))}
            />
            <Stepper
              label="rows"
              value={rows}
              onDec={() => setRows((v) => Math.max(1, v - 1))}
              onInc={() => setRows((v) => Math.min(8, v + 1))}
            />
            <button type="button" className={controls.btn} onClick={resetAuto}>
              {t('mod.autoArrange')}
            </button>
            <span className={styles.hint}>{t('mod.layoutHint')}</span>
          </div>

          <div
            ref={canvasRef}
            className={styles.canvas}
            style={{
              gridTemplateColumns: colSizes
                .map((s) => `minmax(0, ${Math.max(0.05, s)}fr)`)
                .join(' '),
              gridTemplateRows: rowSizes
                .map((s) => `minmax(0, ${Math.max(0.05, s)}fr)`)
                .join(' '),
            }}
          >
            {/* slots de fundo (visual apenas — drop é pointer-based no box) */}
            {cellsArray.map(({ col, row }) => (
              <div
                key={`slot-${col}-${row}`}
                className={`${styles.slot} ${dragging ? styles.slotActive : ''}`}
                style={{ gridColumn: col, gridRow: row, pointerEvents: 'none' }}
              />
            ))}
            {/* resizers verticais (entre cols) */}
            {Array.from({ length: cols - 1 }).map((_, i) => (
              <div
                key={`crz-${i}`}
                className={styles.colResizer}
                style={{
                  gridColumn: i + 2,
                  gridRow: `1 / span ${rows}`,
                }}
                onPointerDown={(e) => startColResize(i + 1, e)}
              />
            ))}
            {/* resizers horizontais (entre rows) */}
            {Array.from({ length: rows - 1 }).map((_, i) => (
              <div
                key={`rrz-${i}`}
                className={styles.rowResizer}
                style={{
                  gridRow: i + 2,
                  gridColumn: `1 / span ${cols}`,
                }}
                onPointerDown={(e) => startRowResize(i + 1, e)}
              />
            ))}
            {/* filhos posicionados */}
            {children.map((child) => {
              const cell = cells[child.id]
              if (!cell) return null
              const isSelected = selected === child.id
              return (
                <div
                  key={child.id}
                  className={`${styles.box} ${isSelected ? styles.boxSelected : ''} ${
                    dragging === child.id ? styles.boxDragging : ''
                  }`}
                  style={{
                    gridColumn: `${cell.col} / span ${cell.colSpan}`,
                    gridRow: `${cell.row} / span ${cell.rowSpan}`,
                    borderColor: isSelected ? 'var(--accent)' : undefined,
                  }}
                  onPointerDown={(e) => startDrag(child.id, e)}
                  onClick={() =>
                    setSelected((cur) => (cur === child.id ? null : child.id))
                  }
                >
                  <div className={styles.boxHeader}>
                    {child.color ? (
                      <span
                        className={styles.colorChip}
                        style={{ background: child.color }}
                      />
                    ) : null}
                    <span className={styles.boxLabel}>{child.label}</span>
                    <span className={styles.boxSpanBadge}>
                      {cell.colSpan}×{cell.rowSpan}
                    </span>
                  </div>
                  {child.hint ? (
                    <div className={styles.boxHint}>{child.hint}</div>
                  ) : null}
                  <div
                    className={styles.resizeHandle}
                    data-resize-handle="1"
                    onPointerDown={(e) => startResize(child.id, e)}
                    title={t('mod.dragToResize')}
                  />
                </div>
              )
            })}
          </div>

          <footer className={styles.footer}>
            {clearWorkspace ? (
              <button
                type="button"
                className={controls.btn}
                onClick={clearWorkspace}
                style={{ marginRight: 'auto' }}
              >
                {t('mod.removeCustomLayout')}
              </button>
            ) : null}
            <button type="button" className={controls.btn} onClick={onClose}>
              {t('mod.cancel')}
            </button>
            <button
              type="button"
              className={`${controls.btn} ${controls.btnPrimary}`}
              onClick={save}
            >
              {t('mod.saveLayout')}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Stepper({
  label,
  value,
  onDec,
  onInc,
}: {
  label: string
  value: number
  onDec: () => void
  onInc: () => void
}) {
  const t = useT()
  return (
    <div className={styles.stepper}>
      <span className={styles.stepperLabel}>{label}</span>
      <button
        type="button"
        className={styles.stepperBtn}
        onClick={onDec}
        aria-label={t('mod.decrease', { label })}
      >
        <Minus size={12} />
      </button>
      <span className={styles.stepperValue}>{value}</span>
      <button
        type="button"
        className={styles.stepperBtn}
        onClick={onInc}
        aria-label={t('mod.increase', { label })}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}
