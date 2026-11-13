// Native Claude observation is independent of Pi transport and never delivers model context.
import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, On } from 'claude-code'
import type { ClaudeCrew, ClaudeMsg, ClaudeView, ClaudeWorker } from '../types'
import { claudeMessage, claudeRoster, claudeText, observeClaude, resolveClaude } from './model'

const EMPTY: ClaudeCrew = { sessionId: '', workers: [], messages: [], sequence: 0 }
const START: ClaudeView = { messages: [], following: true, newer: [], expanded: [], request: 0, loading: false }
const crew = atom({ plugin: 'pi-crew', key: 'claude' } as const, EMPTY, { shape: 'claude-1' })
const view = atom({ plugin: 'pi-crew', key: 'claudeView' } as const, START, { shape: 'claude-view-1' })
const REFRESH_MS = 5_000
let enabled = false
let rosterRequest = 0

/** A clear/resume changes the conversation without necessarily raising session.start again. */
async function owner($: Engine): Promise<string> {
  const sessionId = await $.session.id()
  if ((await read($, crew)).sessionId !== sessionId) {
    let changed = false
    await update($, crew, c => {
      changed = c.sessionId !== sessionId
      return changed ? { ...EMPTY, sessionId } : c
    })
    if (changed) await update($, view, v => ({ ...START, request: v.request + 1 }))
  }
  return sessionId
}

async function current($: Engine, sessionId: string): Promise<boolean> {
  return await $.session.id() === sessionId && (await read($, crew)).sessionId === sessionId
}

async function problem($: Engine, error: unknown) {
  $.ui.log('pi-crew: Claude observer: ' + String(error), { to: 'debug' })
}

export async function refreshClaude($: Engine) {
  if (!enabled) return
  const sessionId = await owner($)
  const request = ++rosterRequest
  try {
    const roster = await $.agent.list()
    const now = await $.clock.now()
    if (request !== rosterRequest || !await current($, sessionId)) return
    const previous = await read($, crew)
    const workers = claudeRoster(previous.workers, roster, now)
    if (!previous.error && workers.length === previous.workers.length && workers.every((w, i) => w === previous.workers[i]) && previous.messages.every(m => now - m.at < 86_400_000)) return
    await update($, crew, c => c.sessionId !== sessionId || request !== rosterRequest ? c : ({ ...c, workers: claudeRoster(c.workers, roster, now), messages: c.messages.filter(m => now - m.at < 86_400_000), error: undefined }))
  } catch (error) {
    if (await current($, sessionId)) await update($, crew, c => c.sessionId !== sessionId || request !== rosterRequest ? c : ({ ...c, error: String(error) }))
  }
}

async function refreshLoop($: Engine) {
  for (;;) {
    await $.clock.sleep(REFRESH_MS)
    await refreshClaude($).catch(error => problem($, error))
  }
}

export async function readClaude($: Engine) {
  const c = await read($, crew)
  if (c.sessionId && c.sessionId !== await $.session.id()) return { crew: EMPTY, view: START }
  return { crew: c, view: await read($, view) }
}

export function closeClaude($: Engine) {
  return update($, view, v => ({ ...START, request: v.request + 1 }))
}

async function record($: Engine, sessionId: string, msg: Omit<ClaudeMsg, 'id' | 'at' | 'generation'>, id?: string, generation?: number) {
  const now = await $.clock.now()
  if (!await current($, sessionId)) return
  let added: ClaudeMsg | undefined
  await update($, crew, c => {
    added = undefined
    const worker = c.workers.find(w => w.id === msg.worker)
    if (c.sessionId !== sessionId || !worker || (generation !== undefined && worker.generation !== generation)) return c
    const next = { ...msg, generation: worker.generation, id: id ?? 'message-' + (c.sequence + 1), at: now, text: claudeText(msg.text) }
    if (c.messages.some(m => m.id === next.id)) return c
    added = next
    return claudeMessage(c, next)
  })
  const message = added
  if (message) await update($, view, v => observeClaude(v, sessionId, message))
}

export async function openClaude($: Engine, worker: ClaudeWorker) {
  const c = await read($, crew)
  await update($, view, v => ({
    ...START, request: v.request + 1, selected: { sessionId: c.sessionId, id: worker.id, generation: worker.generation },
    messages: c.messages.filter(m => m.worker === worker.id && m.generation === worker.generation),
  }))
}

export async function latestClaude($: Engine) {
  const c = await read($, crew)
  await update($, view, v => ({
    ...v, request: v.request + 1, following: true, newer: [], loading: false, conversation: undefined, error: undefined,
    messages: c.messages.filter(m => m.worker === v.selected?.id && m.generation === v.selected.generation),
  }))
}

export function pauseClaude($: Engine) {
  return update($, view, v => ({ ...v, following: false }))
}

export function expandClaude($: Engine, id: string) {
  return update($, view, v => ({ ...v, following: false, expanded: v.expanded.includes(id) ? v.expanded.filter(x => x !== id) : [...v.expanded, id] }))
}

/** Snapshot only: no background transcript polling and no native UI view/prompt-target switch. */
export async function conversationClaude($: Engine) {
  let selected: ClaudeView['selected']
  let request = 0
  await update($, view, v => {
    selected = v.selected
    request = v.request + 1
    return { ...v, request, loading: true, following: false, error: undefined }
  })
  if (!selected) return
  const target = selected
  try {
    const c = await read($, crew)
    if (!await current($, target.sessionId) || !c.workers.some(w => w.id === target.id && w.generation === target.generation)) throw new Error('Worker conversation changed')
    const rows = await $.session.messages({ agentId: target.id })
    if (!Array.isArray(rows)) throw new Error(rows.deny)
    if (!await current($, target.sessionId)) return
    if (!(await read($, crew)).workers.some(w => w.id === target.id && w.generation === target.generation)) throw new Error('Worker conversation changed')
    const conversation = rows.slice(-50).map(m => ({
      role: m.role, text: claudeText(m.text), tools: m.toolUses.map(t => t.tool),
    })).filter(m => m.text || m.tools.length)
    await update($, view, v => v.request !== request ? v : { ...v, loading: false, conversation })
  } catch (error) {
    await update($, view, v => v.request !== request ? v : { ...v, loading: false, error: 'Conversation unavailable: ' + String(error) })
  }
}

export async function startClaude($: Engine) {
  if (enabled) return
  enabled = true
  await refreshClaude($).catch(error => problem($, error))
  void refreshLoop($).catch(error => problem($, error))
}

export function registerClaude(on: On) {
  on('agent.spawn', async ($, e, next) => {
    const sessionId = enabled ? await owner($) : ''
    const result = await next(e)
    if (!sessionId || result.deny || !result.agentId || e.workflow) return result
    if (!await current($, sessionId)) return result
    const now = await $.clock.now()
    const agentId = result.agentId
    let assignment = false
    // Spawn and turn hooks race the roster. Keep the successful dispatch even before list publishes it.
    await update($, crew, c => {
      if (c.sessionId !== sessionId) return c
      const old = c.workers.find(w => w.id === result.agentId)
      const replacement = !e.resume && old?.spawnId && old.spawnId !== e.tool_use_id
      assignment = !e.resume && old?.spawnId !== e.tool_use_id
      const worker: ClaudeWorker = {
        ...(old ?? {
          id: agentId, description: e.description, type: e.subagentType, status: 'pending',
          name: e.name, teammateId: result.teammateId, parentId: e.parentAgentId,
          generation: 1, present: true, startedAt: now, lastAt: now,
        }),
        generation: (old?.generation ?? 1) + (replacement ? 1 : 0),
        spawnId: e.resume ? old?.spawnId : e.tool_use_id, model: result.model,
        task: e.resume ? old?.task : claudeText(e.prompt), startedAt: replacement ? now : old?.startedAt ?? now,
      }
      return { ...c, workers: [...c.workers.filter(w => w.id !== worker.id), worker].slice(-100) }
    })
    if (assignment) await record($, sessionId, { worker: result.agentId, sender: e.parentAgentId ? 'parent' : 'lead', kind: 'assignment', text: e.prompt }, 'spawn-' + e.tool_use_id)
    await refreshClaude($)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (enabled && e.agentId) await refreshClaude($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const sessionId = enabled ? await owner($) : ''
    const generation = sessionId ? (await read($, crew)).workers.find(w => w.id === e.agentId)?.generation : undefined
    const result = await next(e)
    if (sessionId && e.agentId) {
      await refreshClaude($)
      if (e.answer) await record($, sessionId, { worker: e.agentId, sender: 'worker', kind: 'result', text: e.answer }, 'turn-' + e.turnId, generation)
    }
    return result
  })

  on('session.send', async ($, e, next) => {
    const sessionId = enabled ? await owner($) : ''
    const before = sessionId ? (await read($, crew)).workers : []
    const generation = (e.agentId ? before.find(w => w.id === e.agentId) : resolveClaude(before, e.to))?.generation
    const result = await next(e)
    if (!sessionId || !result.isDelivered) return result
    await refreshClaude($)
    const c = await read($, crew)
    const worker = e.agentId
      ? ['main', 'team-lead'].includes(e.to) ? c.workers.find(w => w.id === e.agentId) : undefined
      : resolveClaude(c.workers, e.to)
    if (worker) await record($, sessionId, { worker: worker.id, sender: e.agentId ? 'worker' : 'lead', kind: 'message', text: e.text, delivery: 'queued' }, undefined, generation)
    return result
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    const sessionId = enabled ? await owner($) : ''
    const result = await next(e)
    // In-process sends were recorded above. File-backed teammate deliveries have no local send event.
    if (!sessionId || e.agentId || 'consumed' in result || !('teammate' in e.origin) || e.origin.isVerified) return result
    await refreshClaude($)
    const c = await read($, crew)
    const worker = resolveClaude(c.workers, e.origin.teammate)
    if (worker) await record($, sessionId, { worker: worker.id, sender: 'worker', kind: 'message', text: result.text, delivery: 'unverified' })
    return result
  }).catch(($, e, next) => next(e))
}
