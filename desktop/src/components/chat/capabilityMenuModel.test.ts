import { describe, expect, it } from 'vitest'
import type { TranslationKey } from '@/i18n'
import type { AgentDefinition } from '@/api/agents'
import type { ConnectorDto } from '@/types/connector'
import type { ComposerReferenceCandidate } from '@/types/composerReference'
import type { TeamSummary } from '@/types/team'
import type { WorkflowDefinition } from '@/types/workflow'
import {
  buildCapabilitySections,
  filterCapabilitySections,
  type CapabilityMenuInput,
} from './capabilityMenuModel'

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  params?.count !== undefined ? `${key}#${params.count}` : key

const skill: ComposerReferenceCandidate = {
  kind: 'skill',
  id: 'design',
  name: 'design',
  displayName: 'Design',
  description: 'Create interfaces',
  source: 'user',
  modelText: 'Use design',
}

const plugin: ComposerReferenceCandidate = {
  kind: 'plugin',
  id: 'feishu-plugin',
  name: 'feishu',
  displayName: 'Feishu',
  description: 'Feishu tools',
  source: 'plugin',
  modelText: 'Use Feishu',
}

const agent: AgentDefinition = {
  agentType: 'debugger',
  description: 'Debug failures',
  source: 'userSettings',
  isActive: true,
}

const inactiveAgent: AgentDefinition = {
  agentType: 'retired',
  source: 'userSettings',
  isActive: false,
}

const connectedConnector = {
  id: 'feishu',
  displayName: 'Feishu',
  pluginId: 'feishu-plugin',
  connection: 'connected',
  enabled: true,
  installed: true,
  supported: true,
  status: 'ready',
} as unknown as ConnectorDto

const plainConnector = {
  id: 'dingtalk',
  displayName: 'DingTalk',
  pluginId: 'dingtalk-plugin',
  connection: 'connected',
  enabled: true,
  installed: true,
  supported: true,
  status: 'ready',
} as unknown as ConnectorDto

const disconnectedConnector = {
  ...plainConnector,
  id: 'wecom',
  connection: 'disconnected',
} as unknown as ConnectorDto

const team: TeamSummary = { name: 'review-team', memberCount: 3 }

const workflow: WorkflowDefinition = {
  name: 'nightly-review',
  description: 'Review the day',
  source: 'userSettings',
}

function buildInput(overrides: Partial<CapabilityMenuInput> = {}): CapabilityMenuInput {
  return {
    skills: [skill],
    plugins: [plugin],
    agents: [agent, inactiveAgent],
    connectors: [connectedConnector, plainConnector, disconnectedConnector],
    teams: [team],
    workflows: [workflow],
    computerUse: { supported: true, enabled: false },
    teamCreatePrompt: 'Create a team: ',
    t,
    ...overrides,
  }
}

function sectionsById(input: CapabilityMenuInput) {
  const sections = buildCapabilitySections(input)
  return new Map(sections.map(section => [section.id, section]))
}

describe('buildCapabilitySections', () => {
  it('leads with attachments, then capabilities, then commands', () => {
    const sections = buildCapabilitySections(buildInput())
    expect(sections.map(section => section.id)).toEqual(['add', 'capabilities', 'commands'])
    expect(sections[0]!.items[0]!.action).toEqual({ type: 'attachment' })
    expect(sections[2]!.items[0]!.action).toEqual({ type: 'slashTrigger' })
  })

  it('lists skills as mention insertions with a manage footer', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const skills = capabilities.items.find(item => item.key === 'skills')!
    expect(skills.count).toBe(1)
    expect(skills.children!.map(child => child.key)).toEqual(['skill:design', 'skills:manage'])
    expect(skills.children![0]!.action).toEqual({ type: 'insertMention', reference: skill })
    expect(skills.children![1]!.action).toEqual({ type: 'settings', tab: 'skills' })
  })

  it('lists only connected connectors, preferring a plugin mention when one exists', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const connectors = capabilities.items.find(item => item.key === 'connectors')!
    expect(connectors.count).toBe(2)
    expect(connectors.children!.map(child => child.key)).toEqual([
      'connector:feishu',
      'connector:dingtalk',
      'connectors:manage',
    ])
    // Feishu has an installed plugin candidate → mention; DingTalk does not → catalog.
    expect(connectors.children![0]!.action).toEqual({ type: 'insertMention', reference: plugin })
    expect(connectors.children![1]!.action).toEqual({ type: 'connectorsTab' })
    expect(connectors.children![2]!.action).toEqual({ type: 'connectorsTab' })
  })

  it('lists active agents as /agent text insertions and skips inactive ones', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const agents = capabilities.items.find(item => item.key === 'agents')!
    expect(agents.count).toBe(1)
    expect(agents.children![0]).toMatchObject({
      key: 'agent:debugger',
      action: { type: 'insertSlashText', command: 'agent debugger' },
    })
    expect(agents.children!.some(child => child.key === 'agent:retired')).toBe(false)
    expect(agents.children!.at(-1)!.action).toEqual({ type: 'settings', tab: 'agents' })
  })

  it('leads the teams sub-list with a prompt-seed creation row, then existing teams', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const teams = capabilities.items.find(item => item.key === 'teams')!
    expect(teams.count).toBe(1)
    expect(teams.children![0]!.action).toEqual({ type: 'insertPromptSeed', text: 'Create a team: ' })
    expect(teams.children![1]).toMatchObject({
      key: 'team:review-team',
      description: 'chat.capabilities.teamMembers#3',
      action: { type: 'openTeam', teamName: 'review-team' },
    })
  })

  it('renders Computer Use as a switch only when the platform supports it', () => {
    const supported = sectionsById(buildInput()).get('capabilities')!
    const switchRow = supported.items.find(item => item.key === 'computer-use')!
    expect(switchRow.switch).toEqual({ checked: false, disabled: false })
    expect(switchRow.action).toEqual({ type: 'toggleComputerUse' })

    const unsupported = sectionsById(buildInput({ computerUse: { supported: false, enabled: false } })).get('capabilities')!
    const navRow = unsupported.items.find(item => item.key === 'computer-use')!
    expect(navRow.switch).toBeUndefined()
    expect(navRow.action).toEqual({ type: 'settings', tab: 'computerUse' })

    // Status not loaded yet: same navigation fallback, never a dead switch.
    const unknown = sectionsById(buildInput({ computerUse: null })).get('capabilities')!
    expect(unknown.items.find(item => item.key === 'computer-use')!.action)
      .toEqual({ type: 'settings', tab: 'computerUse' })
  })

  it('lists workflows as /name text insertions with a save footer', () => {
    const capabilities = sectionsById(buildInput()).get('capabilities')!
    const workflows = capabilities.items.find(item => item.key === 'workflows')!
    expect(workflows.count).toBe(1)
    expect(workflows.children![0]!.action).toEqual({ type: 'insertSlashText', command: 'nightly-review' })
    expect(workflows.children!.at(-1)!.action).toEqual({ type: 'saveWorkflowPanel' })
  })
})

describe('filterCapabilitySections', () => {
  it('returns sections untouched on an empty query', () => {
    const sections = buildCapabilitySections(buildInput())
    expect(filterCapabilitySections(sections, '  ')).toBe(sections)
  })

  it('promotes matching children to the top level with their action intact', () => {
    const sections = buildCapabilitySections(buildInput())
    const filtered = filterCapabilitySections(sections, 'nightly')
    const items = filtered.flatMap(section => section.items)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      key: 'workflow:userSettings:nightly-review',
      action: { type: 'insertSlashText', command: 'nightly-review' },
    })
  })

  it('keeps children on a matched parent so it still drills in', () => {
    const sections = buildCapabilitySections(buildInput())
    const filtered = filterCapabilitySections(sections, sections[1]!.items[0]!.label)
    const parent = filtered.flatMap(section => section.items).find(item => item.key === 'skills')
    expect(parent?.children?.length).toBeGreaterThan(0)
  })

  it('drops sections with no matches', () => {
    const sections = buildCapabilitySections(buildInput())
    const filtered = filterCapabilitySections(sections, 'nightly')
    expect(filtered.map(section => section.id)).not.toContain('add')
    expect(filtered.map(section => section.id)).not.toContain('commands')
  })
})
