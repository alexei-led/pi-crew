// The lead's side of the bridge: shared state, the bridge client, its supervisor, and the actions the band and pane run.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine } from 'claude-code'

import type { BridgeEvent, CrewInbound, CrewMsg, CrewRequest, CrewView, CrewWorker } from '../types'
import { tag, turnText } from './model'

export const PLUGIN = 'pi-crew'
export const PANE = 'pi-crew'
const TITLE = 'Pi crew'
// The transcript keeps every message; the pane needs only each worker's latest few.
const FEED_LIMIT = 200
const SEEN_LIMIT = 500
const SUBMIT_ATTEMPTS = 10
const SUBMIT_RETRY_MS = 15_000
const BRIDGE_ATTEMPTS = 20
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const TICK_MS = 60_000

// The plugin name is a literal here, not PLUGIN: the engine's state scan accepts only literal plugin and key.
const workers = atom({ plugin: 'pi-crew', key: 'workers' } as const, [] as CrewWorker[], { shape: 'workers-1' })
const feed = atom({ plugin: 'pi-crew', key: 'feed' } as const, [] as CrewMsg[], { shape: 'feed-1' })
const START: CrewView = { tab: 'inbox', filter: 'all', showAll: false, questionExpanded: false, collapsed: [] }
const view = atom({ plugin: 'pi-crew', key: 'view' } as const, START, { shape: 'view-3' })
const tick = atom({ plugin: 'pi-crew', key: 'tick' } as const, 0, { shape: 'tick-1' })
const seen = atom({ plugin: 'pi-crew', key: 'seen' } as const, [] as string[], { shape: 'seen-1' })

// Module state; a reload re-runs register and session.start, which set it again.
let bridgeKey = ''
let bridgeBin = ''
let attempt = 0
// Worker reports become turns one at a time, in arrival order.
let submitting: Promise<void> = Promise.resolve()
// What the user wrote to a worker from the pane since its last report: the next turn tells the model.
export const panelNotes = new Map<string, string[]>()

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

async function deliver($: Engine, ev: CrewInbound) {
  if ((await read($, seen)).includes(ev.id)) {
    await call($, { op: 'ack', id: ev.id })
    return
  }
  const name = ev.from.worker
  const worker = name ? (await read($, workers)).find(w => w.name === name) : undefined
  const peer = name ?? ev.from.name ?? ev.from.id
  const notes = name ? panelNotes.get(name) : undefined
  const body = turnText(worker, ev, notes)
  for (let n = 0; n < SUBMIT_ATTEMPTS; n++) {
    const result = await $.prompt.submit({ text: body })
    if (!result.drop) {
      if (name) panelNotes.delete(name)
      await update($, seen, ids => [...ids, ev.id].slice(-SEEN_LIMIT))
      await call($, { op: 'ack', id: ev.id })
      return
    }
    $.ui.log(`pi-crew: report ${ev.id} from ${peer} not submitted (${result.drop}); retrying`, { to: 'debug' })
    await $.clock.sleep(SUBMIT_RETRY_MS)
  }
  // Left un-acked in the bridge inbox: the next bridge start replays it.
  $.ui.toast(`pi-crew: a report from ${peer} could not start a turn; run /reload-plugins to replay it`)
}

async function onEvent($: Engine, ev: BridgeEvent) {
  switch (ev.type) {
    case 'ready':
      attempt = 0
      await update($, workers, () => ev.workers)
      await update($, feed, () => ev.feed.slice(-FEED_LIMIT))
      $.ui.status(undefined)
      return
    case 'workers':
      await update($, workers, () => ev.workers)
      return
    case 'feed':
      await update($, feed, list => (list.some(m => m.id === ev.msg.id) ? list : [...list, ev.msg].slice(-FEED_LIMIT)))
      return
    case 'feedset':
      await update($, feed, () => ev.feed.slice(-FEED_LIMIT))
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

/** Ages in the band and pane redraw once a minute while anyone works. */
export async function tickLoop($: Engine) {
  for (;;) {
    await $.clock.sleep(TICK_MS)
    if ((await read($, workers)).some(w => w.state !== 'gone')) await update($, tick, t => t + 1)
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
  return update($, view, v => ({ ...v, confirmStop: undefined, ...patch }))
}

export function toggleGroup($: Engine, name: string) {
  return update($, view, v => ({ ...v, collapsed: v.collapsed.includes(name) ? v.collapsed.filter(n => n !== name) : [...v.collapsed, name] }))
}

export function showPane($: Engine) {
  return $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
}

export async function closePane($: Engine) {
  await setView($, {})
  await $.ui.close({ id: PANE })
}

export async function openThread($: Engine, w: CrewWorker) {
  await setView($, { sel: w.name, showAll: false, questionExpanded: false })
  if (w.unread > 0 && bridgeKey) await call($, { op: 'read', name: w.name })
}

export async function openPane($: Engine, patch: Partial<CrewView>, w?: CrewWorker) {
  await setView($, { sel: undefined, ...patch })
  if (w) await openThread($, w)
  await showPane($)
}

export async function reply($: Engine, w: CrewWorker, text: string) {
  await setView($, {})
  const t = text.trim()
  if (!t) return
  if (await act($, { op: 'send', to: w.name, text: t, replyTo: w.ask?.id }, `send to ${tag(w)}`)) {
    panelNotes.set(w.name, [...(panelNotes.get(w.name) ?? []), t])
  }
}
