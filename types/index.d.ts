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
  /** Unique identity for this spawn; stable across bridge restarts. Legacy workers can lack it until respawn. */
  runId?: string
  /** The latest task explicitly assigned to this run. */
  task?: { text: string; at: number }
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
  /** The worker run and sender identity are absent on legacy feed records. */
  runId?: string
  sender?: 'lead' | 'worker'
  checks?: { ok: boolean; notes: string[]; at: number }
}

/** One chronological page from the current worker run's retained feed. */
export type CrewHistory = { name: string; runId?: string; messages: CrewMsg[]; hasOlder: boolean }

/** A request to the bridge's control socket: `crew-bridge call --key <k> '<json>'`. */
export type CrewRequest =
  | { op: 'list' }
  | { op: 'send'; to: string; text: string; replyTo?: string; task?: string }
  | { op: 'history'; name: string; runId?: string; before?: string; limit?: number }
  | { op: 'spawn'; name: string; cwd: string; model?: string; task?: string; group?: string; allowDefaultBranch?: boolean }
  | { op: 'stop'; name: string }
  | { op: 'read'; name: string }
  | { op: 'focus'; name: string }
  | { op: 'ack'; id: string }

export type CrewInboundBase = {
  type: 'message'
  runId?: string
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

export type CrewView = {
  sel?: string
  runId?: string
  collapsed: string[]
  expanded: string[]
  following: boolean
  newer: string[]
  request: number
  loading?: boolean
  arriving?: CrewMsg[]
  history?: CrewHistory
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pi-crew': {
      workers: Shaped<CrewWorker[]>
      feed: Shaped<CrewMsg[]>
      view: Shaped<CrewView>
      /** A counter bumped each minute while workers are listed, so ages redraw. */
      tick: Shaped<number>
      /** Ids of worker messages the lead already has: a replay after a reload is skipped. */
      seen: Shaped<string[]>
      /** Progress reports waiting for the next turn. */
      held: Shaped<CrewInbound[]>
    }
  }
}
