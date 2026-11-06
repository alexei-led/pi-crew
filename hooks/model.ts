// Pure view logic shared by the band, the pane and the turn text: one vocabulary of glyphs, numbers and names.
import type { CrewFilter, CrewMsg, CrewState, CrewWorker } from '../types'

export const GLYPH: Record<CrewState, string> = { ask: '◆', work: '●', idle: '○', gone: '✕' }
export const COLOR: Record<CrewState, string | undefined> = { ask: 'yellow', work: 'green', idle: undefined, gone: 'gray' }
export const UNREAD = '✉'
/** The bridge's alert that a working worker went quiet: not a worker state, so not in GLYPH. */
export const IDLE_GLYPH = '◇'
export const LABEL: Record<CrewState, string> = { ask: 'needs you', work: 'working', idle: 'idle', gone: 'stopped' }

/** "3 api": the number and name every surface shows for a worker. */
export const tag = (w: Pick<CrewWorker, 'n' | 'name'>) => `${w.n} ${w.name}`

export function age(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export function clip(text: string, max: number): string {
  if (max <= 0) return ''
  if (max === 1) return text ? '…' : ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export type Tally = { crew: number; ask: number; work: number; idle: number; gone: number; unread: number }

export function tally(ws: CrewWorker[]): Tally {
  const t: Tally = { crew: 0, ask: 0, work: 0, idle: 0, gone: 0, unread: 0 }
  for (const w of ws) {
    t[w.state]++
    if (w.state !== 'gone') t.crew++
    t.unread += w.unread
  }
  return t
}

export const matches = (w: CrewWorker, filter: CrewFilter) => filter === 'all' || w.state === filter

/** Who to look at first: open questions (oldest first), then unread, then the rest by latest activity; stopped last. */
export function inboxOrder(ws: CrewWorker[]): CrewWorker[] {
  const rank = (w: CrewWorker) => (w.state === 'gone' ? 3 : w.state === 'ask' ? 0 : w.unread > 0 ? 1 : 2)
  return [...ws].sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r) return r
    if (a.state === 'ask' && b.state === 'ask') return (a.ask?.at ?? a.lastAt) - (b.ask?.at ?? b.lastAt)
    return b.lastAt - a.lastAt || a.n - b.n
  })
}

/** The open question to answer next: the oldest. */
export const nextQuestion = (ws: CrewWorker[]) => inboxOrder(ws).find(w => w.state === 'ask' && w.ask)

export const UNGROUPED = 'crew'

/** Groups in the order their first worker was spawned; workers by number. */
export function groups(ws: CrewWorker[]): Array<{ name: string; workers: CrewWorker[] }> {
  const by = new Map<string, CrewWorker[]>()
  for (const w of [...ws].sort((a, b) => a.n - b.n)) {
    const g = w.group ?? UNGROUPED
    by.set(g, [...(by.get(g) ?? []), w])
  }
  return [...by].map(([name, workers]) => ({ name, workers }))
}

export const threadOf = (feed: CrewMsg[], name: string) => feed.filter(m => m.worker === name)

/** The newest `limit` items, and how many older ones were left out. */
export function fold<T>(items: T[], limit: number): { hidden: number; shown: T[] } {
  if (items.length <= limit) return { hidden: 0, shown: items }
  return { hidden: items.length - limit, shown: items.slice(-limit) }
}

/** At most `lines` lines of `width` columns; `more` when anything was cut. */
export function clampText(text: string, lines: number, width: number): { text: string; more: boolean } {
  const out: string[] = []
  for (const raw of text.trim().split('\n')) {
    let line = raw.trimEnd()
    do {
      if (out.length === lines) return { text: out.join('\n'), more: true }
      out.push(line.slice(0, width))
      line = line.slice(width)
    } while (line)
  }
  return { text: out.join('\n'), more: false }
}

/** The line a DONE turn carries: what the bridge found checking the report's claims against git. */
export function checksLine(checks: { ok: boolean; notes: string[] } | undefined): string {
  if (!checks) return ''
  return checks.ok
    ? 'DONE checks passed: fields present, HEAD and branch as claimed, tree clean. Still review the work itself.'
    : `DONE checks failed: ${checks.notes.join('; ')}. Treat the report as unverified.`
}

/** The sentence a worker message becomes as a turn: same glyph, number and name as the band and pane. */
export function turnHead(w: CrewWorker | undefined, kind: CrewMsg['kind'] | 'idle', peer: string): string {
  if (!w) return `Message from intercom session "${peer}" (not a crew worker)`
  if (kind === 'idle') return `${IDLE_GLYPH} Worker ${tag(w)} is idle without a report`
  const verb = kind === 'ask' ? 'asks' : kind === 'done' ? 'reports done' : 'reports'
  return `${kind === 'ask' ? GLYPH.ask : kind === 'done' ? GLYPH.idle : GLYPH.work} Worker ${tag(w)} ${verb}`
}

export type Inbound = {
  type: 'message'
  from: { id: string; name?: string; cwd: string; worker?: string }
  id: string
  replyTo?: string
  expectsReply: boolean
  kind: CrewMsg['kind'] | 'idle'
  text: string
  checks?: { ok: boolean; notes: string[] }
}

/** Human-readable turn: the headline stays searchable independently of transport metadata. */
export function turnText(worker: CrewWorker | undefined, ev: Inbound, notes?: string[]): string {
  const peer = ev.from.worker ?? ev.from.name ?? ev.from.id
  const checks = checksLine(ev.checks)
  return [
    turnHead(worker, ev.kind, peer),
    ...(ev.kind === 'ask' ? [`Answer with mcp__pi-crew__send to "${peer}" replyTo "${ev.id}".`] : []),
    ...(ev.kind === 'idle' ? [`Check it: its screen below, mcp__pi-crew__send to nudge "${peer}", or mcp__pi-crew__stop.`] : []),
    `intercom id ${ev.from.id}, cwd ${ev.from.cwd}, message ${ev.id}${ev.replyTo ? `, in reply to ${ev.replyTo}` : ''}`,
    ...(checks ? [checks] : []),
    ...(notes?.length ? [`Since its last report the user wrote to ${peer} from the crew pane: ${notes.map(n => `"${n}"`).join(', ')}`] : []),
    '',
    ev.text,
  ].join('\n')
}


/** Fit the identity before the preview, sacrificing the name before question text. */
export function bandQuestion(w: CrewWorker, count: number, now: number, width: number): string {
  if (!w.ask || width <= 0) return ''
  const fullPrefix = count > 1 ? `${GLYPH.ask} ${count} asks · ` : `${GLYPH.ask} `
  const compactPrefix = count > 1 ? `${GLYPH.ask}${count} · ` : `${GLYPH.ask} `
  const suffix = ` ${age(w.ask.at, now)}: ${oneLine(w.ask.text)}`
  const prefix = fullPrefix.length + String(w.n).length + 2 + ` ${age(w.ask.at, now)}: `.length + 1 <= width ? fullPrefix : compactPrefix
  const identity = `${prefix}${w.n}`
  if (identity.length > width) return clip(count > 1 ? `${GLYPH.ask}${count}` : `${GLYPH.ask}${w.n}`, width)
  const nameWidth = Math.max(1, Math.min(w.name.length, width - identity.length - 1 - suffix.length))
  const name = clip(w.name, nameWidth)
  const label = `${identity}${name ? ` ${name}` : ''}${suffix}`
  if (label.length <= width) return label
  // If even the age and preview cannot fit, retain as much worker identity as possible.
  if (identity.length + ` ${age(w.ask.at, now)}: `.length + 1 > width) return clip(`${identity} ${w.name}`, width)
  return clip(label, width)
}
