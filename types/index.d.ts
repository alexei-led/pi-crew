export type CrewMember = {
  id: string
  name?: string
  worker?: string
  status?: string
  cwd: string
  model: string
}

export type CrewMessage = {
  at: number
  direction: 'in' | 'out'
  peer: string
  text: string
}

export type CrewLead = { name: string; id: string } | null

declare module 'claude-code' {
  interface PluginState {
    'pi-crew': {
      lead: Shaped<CrewLead>
      roster: Shaped<CrewMember[]>
      log: Shaped<CrewMessage[]>
    }
  }
}
