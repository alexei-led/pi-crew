/** work: on a task · ask: waiting for the lead · idle: done or no task · gone: stopped. */
export type CrewState = 'work' | 'ask' | 'idle' | 'gone'

export type CrewPreview = { id: string; at: number; text: string }

/** A worker as the bridge records it (bridge/lib.mts `Worker`). */
export type CrewWorker = {
  name: string
  id: string
  cwd: string
  model: string
  agtermSession?: string
  n: number
  group?: string
  state: CrewState
  unread: number
  startedAt: number
  lastAt: number
  last?: CrewPreview
  ask?: CrewPreview
}

/** One feed message (bridge/lib.mts `Msg`). `worker` is unset for a session the lead did not spawn. */
export type CrewMsg = {
  id: string
  at: number
  kind: 'ask' | 'done' | 'report' | 'out'
  text: string
  worker?: string
  peer: string
  replyTo?: string
}

export type CrewLead = { name: string; id: string } | null

export type CrewFilter = 'all' | CrewState
export type CrewTab = 'inbox' | 'crew'

/** What the pane shows. `sel` is the worker whose detail fills the pane; `showAll` widens its latest messages. */
export type CrewView = {
  tab: CrewTab
  filter: CrewFilter
  sel?: string
  showAll: boolean
  collapsed: string[]
  confirmStop?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pi-crew': {
      lead: Shaped<CrewLead>
      workers: Shaped<CrewWorker[]>
      feed: Shaped<CrewMsg[]>
      view: Shaped<CrewView>
      /** Minutes since the epoch, bumped while workers run so ages redraw. */
      tick: Shaped<number>
      /** Ids of worker messages already submitted as turns: a replay after a reload is skipped. */
      seen: Shaped<string[]>
    }
  }
}
