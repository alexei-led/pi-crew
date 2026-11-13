import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClaudeCrew, ClaudeMsg, ClaudeStatus, ClaudeView, ClaudeWorker } from '../types/index.d.ts'
import { claudeLabel, claudeMessage, claudeRoster, claudeText, observeClaude, observerBand, resolveClaude } from '../hooks/model.ts'

const worker = (id: string, more: Partial<ClaudeWorker> = {}): ClaudeWorker => ({ id, generation: 1, description: 'Review', type: 'general-purpose', status: 'running', present: true, startedAt: 0, lastAt: 0, ...more })
const msg = (i: number, more: Partial<ClaudeMsg> = {}): ClaudeMsg => ({ id: String(i), worker: 'a', generation: 1, at: i, text: 'identical message', kind: 'message', sender: 'worker', ...more })
const selected = (): ClaudeView => ({ selected: { sessionId: 'lead', id: 'a', generation: 1 }, messages: [], following: true, newer: [], expanded: [], request: 0, loading: false })

test('native status labels do not turn waiting into a lead question or idle into success', () => {
  for (const [status, expected] of [
    ['pending', 'pending'], ['running', 'running'], ['waiting', 'waiting'], ['idle', 'idle'],
    ['completed', 'completed'], ['failed', 'failed'], ['killed', 'stopped'],
  ] satisfies Array<[ClaudeStatus, string]>) assert.equal(claudeLabel(worker('a', { status })), expected)
  assert.equal(claudeLabel(worker('mate@team', { teammateId: 'mate@team' })), 'reported running · liveness unverified')
  assert.equal(claudeLabel(worker('a', { present: false })), 'not tracked · last running')
})

test('roster reconciliation preserves assignments without treating absence as termination', () => {
  const before = worker('a', { name: 'api', task: 'Keep assignment', model: 'deepseek', lastAt: 10 })
  const refreshed = claudeRoster([before], [{ ...before, status: 'idle' }], 100)[0]
  assert.deepEqual([refreshed?.status, refreshed?.task, refreshed?.model, refreshed?.startedAt, refreshed?.lastAt], ['idle', 'Keep assignment', 'deepseek', 0, 10])
  assert.equal(claudeRoster([before], [], 100)[0]?.status, 'running')
  assert.equal(claudeRoster([before], [], 100)[0]?.present, false)
  assert.deepEqual(claudeRoster([before], [], 30 * 60_000 + 10), [])
  assert.equal(claudeRoster([], Array.from({ length: 120 }, (_, i) => worker(String(i))), 0).length, 100)
})

test('native addresses prefer exact identity and refuse ambiguous or stale display names', () => {
  const a = worker('a', { name: 'api' }), b = worker('b', { name: 'api' })
  assert.equal(resolveClaude([a, b], 'api'), undefined)
  assert.equal(resolveClaude([a, b], 'a'), a)
  assert.equal(resolveClaude([a], 'api'), a)
  assert.equal(resolveClaude([{ ...a, present: false }], 'api'), undefined)
  assert.equal(resolveClaude([worker('x', { teammateId: 'api@team' })], 'api@team')?.id, 'x')
})

test('native observation retains repeated text but bounds each generation and the total feed', () => {
  let c: ClaudeCrew = { sessionId: 'lead', workers: [worker('a')], messages: [], sequence: 0 }
  for (let i = 0; i < 70; i++) c = claudeMessage(c, msg(i))
  assert.equal(c.messages.length, 50)
  assert.equal(c.messages[0]?.id, '20')
  assert.equal(c.workers[0]?.lastAt, 69)
  for (let i = 70; i < 400; i++) c = claudeMessage(c, msg(i, { worker: String(i % 10) }))
  assert.equal(c.messages.length, 200)
  c = claudeMessage(c, msg(401, { at: 86_400_500 }))
  assert.deepEqual(c.messages.map(m => m.id), ['401'])
  assert.match(claudeText('x'.repeat(16_001)), /observer text truncated/)
})

test('native thread snapshots reject other owners, agents and generations and stay frozen while browsing', () => {
  const v = selected()
  for (const [owner, message] of [['other', msg(1)], ['lead', msg(1, { worker: 'b' })], ['lead', msg(1, { generation: 2 })]] as const) assert.equal(observeClaude(v, owner, message), v)
  const following = observeClaude(v, 'lead', msg(1))
  assert.deepEqual(following.messages.map(m => m.id), ['1'])
  const pinned = { ...following, following: false }
  const arrived = observeClaude(pinned, 'lead', msg(2))
  assert.deepEqual(arrived.messages, pinned.messages)
  assert.deepEqual(observeClaude(arrived, 'lead', msg(2)).newer, ['2'])
})

test('mixed band includes native-only crews and fits narrow widths', () => {
  const native = [worker('a'), worker('b', { status: 'completed' })]
  assert.match(observerBand([], 100, native), /crew 1 · Pi 0 · Claude 2/)
  for (const width of [0, 1, 15, 40]) assert.ok(observerBand([], width, native).length <= width)
})
