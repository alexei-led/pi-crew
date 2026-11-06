/** work: on a task · ask: waiting for the lead · idle: done or no task · gone: stopped. */
export type CrewState = 'work' | 'ask' | 'idle' | 'gone'

export type CrewPreview = { id: string; at: number; text: string }

/** A worker as the bridge records it (bridge/lib.mts `Worker`). */
export type CrewWorker = {
  name: string
  id: string
  cwd: string
  model: string
  allowDefaultBranch?: boolean
  agtermSession?: string
  /** Spawn order: the number the UI shows next to the name. Not reused while the record exists. */
  n: number
  group?: string
  state: CrewState
  unread: number
  startedAt: number
  lastAt: number
  last?: CrewPreview
  /** The open question, until the lead answers it. */
  ask?: CrewPreview
  /** When the lead was last told this worker sits idle; one alert per idle stretch. */
  alertedAt?: number
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

/** A request to the bridge's control socket: `crew-bridge call --key <k> '<json>'`. */
export type CrewRequest =
  | { op: 'list' }
  | { op: 'send'; to: string; text: string; replyTo?: string }
  | { op: 'spawn'; name: string; cwd: string; model?: string; task?: string; group?: string; allowDefaultBranch?: boolean }
  | { op: 'stop'; name: string }
  | { op: 'read'; name: string }
  | { op: 'focus'; name: string }
  | { op: 'ack'; id: string }

export type CrewInboundBase = {
  type: 'message'
  from: { id: string; name?: string; cwd: string; worker?: string }
  id: string
  replyTo?: string
  expectsReply: boolean
  text: string
}

/** A report the bridge hands the lead: `idle` is the bridge's own alert; only `done` carries `checks`. */
export type CrewInbound =
  | (CrewInboundBase & { kind: Exclude<CrewMsg['kind'], 'done'> | 'idle' })
  | (CrewInboundBase & {
      kind: 'done'
      /** What the bridge found checking the worker's claims against git. */
      checks?: { ok: boolean; notes: string[] }
    })

/** A live intercom session in the roster, as the bridge publishes it (the lead itself left out). */
export type CrewSession = { id: string; name?: string; status?: string; cwd?: string; model?: string; worker?: string }

/** One JSON line the bridge writes to stdout for the mod. */
export type BridgeEvent =
  | { type: 'ready'; lead: { name: string; id: string }; agtermSession: string | null; workers: CrewWorker[]; feed: CrewMsg[] }
  | { type: 'workers'; workers: CrewWorker[] }
  | { type: 'feed'; msg: CrewMsg }
  | { type: 'feedset'; feed: CrewMsg[] }
  | { type: 'roster'; sessions: CrewSession[] }
  | { type: 'error'; error: string }
  | CrewInbound

export type CrewFilter ='all' | CrewState
export type CrewTab = 'inbox' | 'crew'

/** What the pane shows. `sel` is the worker whose detail fills the pane; `showAll` widens its latest messages; `questionExpanded` shows the full question. */
export type CrewView = {
  tab: CrewTab
  filter: CrewFilter
  sel?: string
  showAll: boolean
  questionExpanded: boolean
  collapsed: string[]
  confirmStop?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pi-crew': {
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
