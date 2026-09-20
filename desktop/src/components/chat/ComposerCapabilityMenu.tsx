import { useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import { useTranslation } from '@/i18n'
import { publicAssetPath } from '@/lib/publicAsset'
import { Switch } from '@/components/ui/Switch'
import {
  filterCapabilitySections,
  type CapabilityAction,
  type CapabilityIcon,
  type CapabilityMenuItem,
  type CapabilityMenuSection,
} from './capabilityMenuModel'

/**
 * The composer's "+" capability menu: one searchable panel that surfaces the
 * things a chat can use — skills, connectors, agents, teams, Computer Use,
 * workflows — next to attachments and slash commands. Data and actions come
 * from `capabilityMenuModel`; this component only renders, navigates and
 * dispatches.
 *
 * Focus stays in the search input the whole time; rows are highlighted via
 * aria-activedescendant, the same pattern the @-reference menu uses.
 */

type Props = {
  id: string
  sections: CapabilityMenuSection[]
  onAction(action: CapabilityAction): void
  onClose(): void
  mobile?: boolean
}

export function getCapabilityMenuOptionId(id: string, index: number): string {
  return `${id}-option-${index}`
}

function RowIcon({ icon, iconColor }: { icon: CapabilityIcon, iconColor?: string }) {
  if (icon.kind === 'image') {
    return <img src={publicAssetPath(icon.src)} alt="" className="h-5 w-5 shrink-0 object-contain" />
  }
  if (icon.kind === 'slash') {
    return (
      <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center text-[15px] font-bold text-[var(--color-text-secondary)]">
        /
      </span>
    )
  }
  const Icon = icon.icon
  return (
    <Icon
      aria-hidden="true"
      className="h-5 w-5 shrink-0 text-[var(--color-text-secondary)]"
      style={iconColor ? { color: iconColor } : undefined}
      strokeWidth={1.7}
    />
  )
}

export function ComposerCapabilityMenu({ id, sections, onAction, onClose, mobile = false }: Props) {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const [drillKey, setDrillKey] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => filterCapabilitySections(sections, query), [sections, query])

  // Drilling only exists without a query: search results are already flat, and
  // keeping the drill stack while filtering would resurrect rows the user just
  // filtered away.
  const drillParent = query.trim()
    ? null
    : filtered.flatMap(section => section.items).find(item => item.key === drillKey && item.children) ?? null

  type Row = { item: CapabilityMenuItem, sectionTitle: string | null }
  const rows: Row[] = drillParent
    ? (drillParent.children ?? []).map(item => ({ item, sectionTitle: null }))
    : filtered.flatMap(section => section.items.map(item => ({ item, sectionTitle: section.title })))

  const activeIndex = rows.length ? Math.min(highlight, rows.length - 1) : -1
  const activeOptionId = activeIndex < 0 ? undefined : getCapabilityMenuOptionId(id, activeIndex)

  const activate = (row: Row | undefined) => {
    if (!row || row.item.disabled) return
    if (row.item.children && !query.trim()) {
      setDrillKey(row.item.key)
      setHighlight(0)
      return
    }
    if (row.item.action) onAction(row.item.action)
  }

  const goBack = () => {
    setDrillKey(null)
    setHighlight(0)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!rows.length) return
      const next = (Math.max(activeIndex, 0) + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
      setHighlight(next)
      const optionId = getCapabilityMenuOptionId(id, next)
      listRef.current?.ownerDocument.getElementById(optionId)?.scrollIntoView?.({ block: 'nearest' })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activate(rows[activeIndex])
    } else if (event.key === 'ArrowRight') {
      const row = rows[activeIndex]
      if (row?.item.children && !query.trim()) {
        event.preventDefault()
        activate(row)
      }
    } else if (event.key === 'ArrowLeft' || (event.key === 'Backspace' && !query)) {
      if (drillParent) {
        event.preventDefault()
        goBack()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (drillParent) goBack()
      else onClose()
    }
  }

  let offset = 0
  const renderRow = (row: Row, index: number) => {
    const { item } = row
    const active = index === activeIndex
    return (
      <div
        key={item.key}
        id={getCapabilityMenuOptionId(id, index)}
        role={item.switch ? 'menuitemcheckbox' : 'option'}
        aria-selected={active}
        aria-checked={item.switch ? item.switch.checked : undefined}
        aria-disabled={item.disabled || undefined}
        title={item.disabledReason}
        onMouseEnter={() => setHighlight(index)}
        onClick={event => {
          // The switch toggles itself; the row around it must not double-fire.
          if (item.switch && (event.target as Element).closest('[data-capability-switch]')) return
          activate(row)
        }}
        className={`flex min-w-0 items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-left focus-visible:outline-none ${
          item.disabled
            ? 'cursor-not-allowed opacity-50'
            : `cursor-default ${active ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'}`
        }`}
      >
        <RowIcon icon={item.icon} iconColor={item.iconColor} />
        <span className="max-w-[45%] shrink-0 truncate text-sm font-medium text-[var(--color-text-primary)]">
          {item.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-tertiary)]">
          {item.description ?? ''}
        </span>
        {item.switch ? (
          <span data-capability-switch className="-my-1 shrink-0" onClick={event => event.stopPropagation()}>
            <Switch
              size="sm"
              checked={item.switch.checked}
              disabled={item.switch.disabled}
              label={t('chat.capabilities.computerUseToggle')}
              labelHidden
              onChange={() => item.action && onAction(item.action)}
            />
          </span>
        ) : item.children ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-tertiary)]">
            {typeof item.count === 'number' ? <span>{item.count}</span> : null}
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </span>
        ) : typeof item.count === 'number' ? (
          <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{item.count}</span>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={`absolute bottom-full left-0 z-[var(--z-dropdown)] mb-2 overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)] ${
        mobile ? 'w-[min(320px,calc(100vw-32px))]' : 'w-[320px]'
      }`}
      onMouseDown={event => {
        // Keep the composer from losing focus to the panel chrome; the search
        // input re-focuses itself on click below.
        event.preventDefault()
      }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border-separator)] px-3 py-2">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-[var(--color-text-tertiary)]" />
        <input
          // autoFocus is intentional: the menu opens on an explicit button
          // press and moving focus into search is the point.
          autoFocus
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setHighlight(0)
          }}
          onKeyDown={handleKeyDown}
          onClick={event => event.currentTarget.focus()}
          placeholder={t('chat.capabilities.searchPlaceholder')}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={activeOptionId}
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        />
      </div>

      <div ref={listRef} id={`${id}-list`} role="listbox" aria-label={t('chat.composerTools')} className="max-h-[360px] overflow-y-auto p-1.5">
        {drillParent ? (
          <div role="group" aria-label={drillParent.label}>
            <div
              role="button"
              tabIndex={-1}
              onClick={goBack}
              className="flex cursor-default items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-left hover:bg-[var(--color-surface-hover)]"
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4 text-[var(--color-text-tertiary)]" />
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">{drillParent.label}</span>
            </div>
            {rows.map((row, index) => renderRow(row, index))}
          </div>
        ) : (
          filtered.map(section => {
            const start = offset
            offset += section.items.length
            return (
              <div key={section.id} role="group" aria-label={section.title}>
                <div className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--color-text-tertiary)]">{section.title}</div>
                {section.items.map((item, position) => renderRow({ item, sectionTitle: section.title }, start + position))}
              </div>
            )
          })
        )}
        {!rows.length ? (
          <div className="px-3 py-3 text-xs text-[var(--color-text-tertiary)]">{t('chat.capabilities.empty')}</div>
        ) : null}
      </div>
    </div>
  )
}
