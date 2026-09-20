import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { ComposerCapabilityMenu } from './ComposerCapabilityMenu'
import type { CapabilityMenuSection } from './capabilityMenuModel'

function fixtureSections(): CapabilityMenuSection[] {
  return [
    {
      id: 'add',
      title: 'Add',
      items: [{
        key: 'add-files',
        label: 'Add files or photos',
        icon: { kind: 'slash' },
        action: { type: 'attachment' },
      }],
    },
    {
      id: 'capabilities',
      title: 'Capabilities',
      items: [
        {
          key: 'skills',
          label: 'Skills',
          description: 'Add a skill to this chat',
          icon: { kind: 'slash' },
          count: 1,
          children: [
            {
              key: 'skill:design',
              label: 'Design',
              description: 'Create interfaces',
              icon: { kind: 'slash' },
              action: { type: 'insertSlashText', command: 'design' },
            },
            {
              key: 'skills:manage',
              label: 'Manage skills',
              icon: { kind: 'slash' },
              action: { type: 'settings', tab: 'skills' },
            },
          ],
        },
        {
          key: 'computer-use',
          label: 'Computer Use',
          description: 'Let Claude operate apps',
          icon: { kind: 'slash' },
          switch: { checked: false, disabled: false },
          action: { type: 'toggleComputerUse' },
        },
      ],
    },
    {
      id: 'commands',
      title: 'Commands',
      items: [{
        key: 'slash-commands',
        label: 'Slash commands',
        icon: { kind: 'slash' },
        action: { type: 'slashTrigger' },
      }],
    },
  ]
}

function renderMenu(overrides: Partial<Parameters<typeof ComposerCapabilityMenu>[0]> = {}) {
  const onAction = vi.fn()
  const onClose = vi.fn()
  render(
    <ComposerCapabilityMenu
      id="cap"
      sections={fixtureSections()}
      onAction={onAction}
      onClose={onClose}
      {...overrides}
    />,
  )
  return { onAction, onClose }
}

function searchInput(): HTMLElement {
  return screen.getByRole('combobox')
}

describe('ComposerCapabilityMenu', () => {
  it('renders section titles and dispatches a leaf action on click', () => {
    const { onAction } = renderMenu()
    expect(screen.getByText('Add')).toBeInTheDocument()
    expect(screen.getByText('Capabilities')).toBeInTheDocument()
    expect(screen.getByText('Commands')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /Add files or photos/ }))
    expect(onAction).toHaveBeenCalledWith({ type: 'attachment' })
  })

  it('drills into a sub-list and returns with the back row', () => {
    const { onAction } = renderMenu()

    // Parent rows open their sub-list instead of firing an action.
    fireEvent.click(screen.getByRole('option', { name: /Skills/ }))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.getByRole('option', { name: /Design/ })).toBeInTheDocument()

    // Back navigation restores the top-level sections.
    fireEvent.click(screen.getByRole('button', { name: /Skills/ }))
    expect(screen.getByText('Commands')).toBeInTheDocument()

    // Drilling again and picking a leaf fires its action.
    fireEvent.click(screen.getByRole('option', { name: /Skills/ }))
    fireEvent.click(screen.getByRole('option', { name: /Design/ }))
    expect(onAction).toHaveBeenCalledWith({ type: 'insertSlashText', command: 'design' })
  })

  it('navigates with the keyboard from the search input', () => {
    const { onClose } = renderMenu()
    const input = searchInput()

    // Order: Add files → Skills → Computer Use → Slash commands.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('option', { name: /Design/ })).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    // Esc inside a sub-list steps back first, then closes.
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toggles a switch row without double-firing from the row click', () => {
    const { onAction } = renderMenu()
    const row = screen.getByRole('menuitemcheckbox')
    expect(row).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(row.querySelector('input[type="checkbox"]')!)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ type: 'toggleComputerUse' })
  })

  it('filters rows through the search box and flattens sub-list matches', () => {
    renderMenu()
    fireEvent.change(searchInput(), { target: { value: 'Design' } })
    expect(screen.getByRole('option', { name: /Design/ })).toBeInTheDocument()
    expect(screen.queryByText('Commands')).not.toBeInTheDocument()

    fireEvent.change(searchInput(), { target: { value: 'no-such-capability' } })
    expect(screen.getByText('No matches')).toBeInTheDocument()
  })
})
