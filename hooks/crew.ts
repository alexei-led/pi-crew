// The lead's side of the bridge: shared state, the bridge client, its supervisor, and the actions the band and pane run.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PromptSubmitInput, PromptSubmitResult } from 'claude-code'

import type { BridgeEvent, CrewInbound, CrewMsg, CrewRequest, CrewView, CrewWorker } from '../types'
import { HISTORY_PAGE_SIZE, isHistory, mergeMessages, observeMessage, progressText, startsTurn, turnText } from './model'

export const PLUGIN = 'pi-crew'
export const PANE = 'pi-crew'
const TITLE = 'crew'
// The transcript keeps every message; the pane needs only each worker's latest few.
const FEED_LIMIT = 200
const SEEN_LIMIT = 500
// Progress that waits for the next turn; past this the oldest is dropped unread by the model (the pane still has it).
const HELD_LIMIT = 50
const SUBMIT_ATTEMPTS = 10
const SUBMIT_RETRY_MS = 15_000
const BRIDGE_ATTEMPTS = 20
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const TICK_MS = 60_000

// The plugin name is a literal here, not PLUGIN: the engine's state scan accepts only literal plugin and key.
const workers = atom({ plugin: 'pi-crew', key: 'workers' } as const, [] as CrewWorker[], { shape: 'workers-1' })
const feed = atom({ plugin: 'pi-crew', key: 'feed' } as const, [] as CrewMsg[], { shape: 'feed-1' })
const START: CrewView = { collapsed: [], expanded: [], following: true, newer: [], request: 0 }
const view = atom({ plugin: 'pi-crew', key: 'view' } as const, START, { shape: 'view-4' })
const tick = atom({ plugin: 'pi-crew', key: 'tick' } as const, 0, { shape: 'tick-1' })
const seen = atom({ plugin: 'pi-crew', key: 'seen' } as const, [] as string[], { shape: 'seen-1' })
const held = atom({ plugin: 'pi-crew', key: 'held' } as const, [] as CrewInbound[], { shape: 'held-1' })

// Module state; a reload re-runs register and session.start, which set it again.
let bridgeKey = ''
let bridgeBin = ''
let attempt = 0
// Worker reports become turns one at a time, in arrival order.
let submitting: Promise<void> = Promise.resolve()

/** True once session.start has claimed this session as a lead. */
export const connected = () => bridgeKey !== ''

export async function call($: Engine, request: CrewRequest): Promise<{ ok: boolean; error?: string; raw: string }> {
  const ran = await $.process.run([bridgeBin, 'call', '--key', bridgeKey, JSON.stringify(request)])
  const raw = ran.stdout.trim() || JSON.stringify({ ok: false, error: ran.stderr.trim() || `exit ${ran.exitCode}` })
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string }
    return { ok: parsed.ok === true, error: parsed.error, raw }
  } catch {
    return { ok: false, error: raw, raw }
  }
}

/** One key per agterm pane: reloads, /clear and resume in that pane keep the same lead id and workers. */
async function resolveKey($: Engine): Promise<string> {
  const ran = await $.process.run(['sh', '-c', 'printf %s "${AGTERM_SESSION_ID:-}"'])
  const raw = ran.stdout.trim() || (await $.session.id())
  return raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)
}

export async function connect($: Engine) {
  bridgeKey = await resolveKey($)
  bridgeBin = `${$.plugin.root}/bin/crew-bridge`
}

/** The lead has these reports: a replay skips them and the bridge stops counting them as new. */
async function taken($: Engine, events: CrewInbound[]) {
  const ids = new Set(events.map(ev => ev.id))
  await update($, seen, list => [...list, ...ids].slice(-SEEN_LIMIT))
  // A bridge restart may have replayed one into the wait while its turn was entering.
  await update($, held, list => list.filter(ev => !ids.has(ev.id)))
  for (const id of ids) await call($, { op: 'ack', id })
}

/** Takes what `pick` matches out of the waiting progress, so a turn and a prompt never both carry one report. */
async function claim($: Engine, pick: (ev: CrewInbound) => boolean): Promise<CrewInbound[]> {
  let claimed: CrewInbound[] = []
  await update($, held, list => {
    claimed = list.filter(pick)
    return list.filter(ev => !pick(ev))
  })
  return claimed
}

/** Puts claimed progress back to wait, ahead of what arrived since. */
function restore($: Engine, events: CrewInbound[]) {
  return update($, held, list => [...events, ...list.filter(ev => !events.some(back => back.id === ev.id))])
}

/** A worker's progress waits here, un-acked, so a bridge restart replays it; the band counts it as new. */
async function hold($: Engine, ev: CrewInbound) {
  let dropped: CrewInbound[] = []
  await update($, held, list => {
    const all = list.some(m => m.id === ev.id) ? list : [...list, ev]
    dropped = all.slice(0, -HELD_LIMIT)
    return all.slice(-HELD_LIMIT)
  })
  if (dropped.length) await taken($, dropped)
}

async function deliver($: Engine, ev: CrewInbound) {
  if ((await read($, seen)).includes(ev.id)) {
    await call($, { op: 'ack', id: ev.id })
    return
  }
  if (!startsTurn(ev)) {
    await hold($, ev)
    return
  }
  const name = ev.from.worker
  const worker = name ? (await read($, workers)).find(w => w.name === name) : undefined
  const peer = name ?? ev.from.name ?? ev.from.id
  for (let n = 0; n < SUBMIT_ATTEMPTS; n++) {
    // The turn about a worker carries the progress it sent while the lead was not looking.
    const earlier = name ? await claim($, m => m.from.worker === name && m.runId === ev.runId) : []
    let drop: string | undefined = 'failed'
    try {
      drop = (await $.prompt.submit({ text: turnText(worker, ev, earlier) })).drop
    } finally {
      if (drop) await restore($, earlier)
    }
    if (!drop) {
      await taken($, [...earlier, ev])
      return
    }
    $.ui.log(`pi-crew: report ${ev.id} from ${peer} not submitted (${drop}); retrying`, { to: 'debug' })
    await $.clock.sleep(SUBMIT_RETRY_MS)
  }
  // Left un-acked in the bridge inbox: the next bridge start replays it.
  $.ui.toast(`pi-crew: a report from ${peer} could not start a turn; run /reload-plugins to replay it`)
}

/** The user's own prompt carries the progress that waited, as context the model reads beside it. */
export async function withProgress(
  $: Engine, e: PromptSubmitInput, next: (e: PromptSubmitInput) => Promise<PromptSubmitResult>,
): Promise<PromptSubmitResult> {
  const waiting = await claim($, () => true)
  if (waiting.length === 0) return next(e)
  let entered = false
  try {
    const ws = await read($, workers)
    const reports = waiting.map(ev => turnText(ws.find(w => w.name === ev.from.worker), ev))
    const result = await next({ ...e, context: [...(e.context ?? []), progressText(reports)] })
    entered = result.drop === undefined
    return result
  } finally {
    await (entered ? taken($, waiting) : restore($, waiting))
  }
}

async function onEvent($: Engine, ev: BridgeEvent) {
  switch (ev.type) {
    case 'ready':
      attempt = 0
      await update($, workers, () => ev.workers)
      await update($, feed, () => ev.feed.slice(-FEED_LIMIT))
      const selected = await read($, view)
      if (selected.sel) void loadHistory($).catch(error => $.ui.log(String(error), { to: 'debug' }))
      $.ui.status(undefined)
      return
    case 'workers':
      await update($, workers, () => ev.workers)
      return
    case 'feed':
      await update($, feed, list => [...list.filter(m => m.id !== ev.msg.id), ev.msg].slice(-FEED_LIMIT))
      await update($, view, v => observeMessage(v, ev.msg))
      if ((await read($, view)).sel && (await read($, view)).following) await $.ui.scroll({ in: PANE, to: 'end' })
      return
    case 'feedset':
      await update($, feed, () => ev.feed.slice(-FEED_LIMIT))
      await update($, view, v => !v.following || !v.history ? v : { ...v, history: { ...v.history, messages: v.history.messages.map(m => ev.feed.find(f => f.id === m.id) ?? m) } })
      return
    case 'roster':
      return
    case 'error':
      $.ui.log(`pi-crew: ${ev.error}`, { to: 'debug' })
      return
    case 'message':
      submitting = submitting.then(() => deliver($, ev)).catch(error => $.ui.log(`pi-crew: deliver: ${String(error)}`, { to: 'debug' }))
      return
    default:
      ev satisfies never
  }
}

/** Restart a bridge that exits (broker gone, crash); the module unloading ends the loop. */
export async function superviseBridge($: Engine) {
  for (; attempt < BRIDGE_ATTEMPTS; attempt++) {
    const bridge = $.process.spawn({ argv: [bridgeBin, 'serve', '--key', bridgeKey] })
    let pending = ''
    try {
      for await (const { stream, text } of bridge) {
        if (stream === 'stderr') {
          $.ui.log(text, { to: 'debug' })
          continue
        }
        pending += text
        let nl: number
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl)
          pending = pending.slice(nl + 1)
          if (!line.trim()) continue
          try {
            await onEvent($, JSON.parse(line) as BridgeEvent)
          } catch (error) {
            $.ui.log(`pi-crew: bad bridge line: ${String(error)}`, { to: 'debug' })
          }
        }
      }
    } catch (error) {
      $.ui.log(`pi-crew: bridge failed: ${String(error)}`, { to: 'debug' })
    }
    $.ui.status('crew: bridge restarting')
    await $.clock.sleep(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt))
  }
  $.ui.status('crew: bridge stopped (run /reload-plugins)')
}

/** Ages in the band and pane redraw once a minute while any worker is listed: a stopped worker's row shows one too. */
export async function tickLoop($: Engine) {
  for (;;) {
    await $.clock.sleep(TICK_MS)
    if ((await read($, workers)).length > 0) await update($, tick, t => t + 1)
  }
}

/**
 * What a render draws from. The engine lists the state a module reads by scanning for atoms declared in the same
 * file as the `read`, so band and pane read through here, and `tick` is read so a render redraws each minute.
 */
export async function readCrew($: Engine) {
  const [ws, fd, v] = [await read($, workers), await read($, feed), await read($, view)]
  await read($, tick)
  return { workers: ws, feed: fd, view: v, now: await $.clock.now() }
}

export async function act($: Engine, request: CrewRequest, what: string): Promise<boolean> {
  if (!bridgeKey) {
    $.ui.toast('pi-crew: the bridge is not running')
    return false
  }
  const answer = await call($, request)
  if (!answer.ok) $.ui.toast(`pi-crew: ${what} failed: ${answer.error ?? 'unknown'}`)
  return answer.ok
}

// The engine follows `$` only into imported function declarations, so these are not arrow consts.
export function setView($: Engine, patch: Partial<CrewView>) {
  return update($, view, v => ({ ...v, ...patch }))
}

export function toggleGroup($: Engine, name: string) {
  return update($, view, v => ({ ...v, collapsed: v.collapsed.includes(name) ? v.collapsed.filter(n => n !== name) : [...v.collapsed, name] }))
}

export function showPane($: Engine) {
  return $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
}

/** Browsing is independent of manager delivery: no read marker or ack is sent here. */
export async function openThread($: Engine, w: CrewWorker) {
  await setView($, { sel: w.name, runId: w.runId, history: undefined, loading: false, arriving: [], error: undefined, expanded: [], following: true, newer: [] })
  await loadHistory($)
}

export async function openPane($: Engine, w?: CrewWorker) {
  await setView($, { sel: undefined, history: undefined, loading: false, arriving: [], error: undefined, newer: [], expanded: [], following: true })
  if (w) await openThread($, w)
  await showPane($)
  if (w) await $.ui.scroll({ in: PANE, to: 'end' })
}

/** The request counter discards replies for an older navigation or an overtaken query. */
export async function loadHistory($: Engine, older = false) {
  let current!: CrewView
  await update($, view, v => {
    current = { ...v, request: v.request + 1, error: undefined, following: !older, loading: true, arriving: [] }
    return current
  })
  if (!current.sel) return
  try {
    if (!connected()) throw new Error('bridge not connected; run /reload-plugins')
    const before = older ? current.history?.messages[0]?.id : undefined
    const answer = await call($, { op: 'history', name: current.sel, runId: current.runId, before, limit: HISTORY_PAGE_SIZE })
    if (!answer.ok) throw new Error(answer.error ?? 'history unavailable')
    const page: unknown = JSON.parse(answer.raw)
    if (!isHistory(page) || page.name !== current.sel || page.runId !== current.runId) throw new Error('invalid history response')
    let accepted = false
    await update($, view, v => {
      if (v.request !== current.request || v.sel !== current.sel || v.runId !== current.runId) return v
      accepted = true
      const messages = older && v.history ? mergeMessages(page.messages, v.history.messages) : mergeMessages(page.messages, v.arriving ?? [])
      return {
        ...v, loading: false, arriving: [],
        history: { ...page, messages: older ? messages : messages.slice(-HISTORY_PAGE_SIZE), hasOlder: page.hasOlder || (!older && messages.length > HISTORY_PAGE_SIZE) },
        newer: older ? v.newer : [], error: undefined,
      }
    })
    if (accepted) await $.ui.scroll({ in: PANE, to: older ? 'start' : 'end' })
  } catch (error) {
    await update($, view, v => v.request !== current.request || v.sel !== current.sel || v.runId !== current.runId ? v : { ...v, error: String(error), following: false, loading: false, arriving: [] })
  }
}

export function expandMessage($: Engine, id: string) {
  return update($, view, v => ({
    ...v, following: false,
    expanded: v.expanded.includes(id) ? v.expanded.filter(i => i !== id) : [...v.expanded, id],
  }))
}

export function pauseHistory($: Engine) {
  return setView($, { following: false })
}
