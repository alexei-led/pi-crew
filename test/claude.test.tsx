import type { AgentInfo, AgentSpawnInput, On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ClaudeCrew, ClaudeView } from '../types'

const agent: AgentInfo = { id: 'native-a', name: 'api', description: 'Review parser', type: 'general-purpose', status: 'running' }
const spawn: AgentSpawnInput = { prompt: 'Review parser safely', description: 'Review parser', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'deepseek', background: true, fork: false, tool_use_id: 'spawn-1', name: 'api' }
const PANE = { plugin: 'pi-crew', component: 'Pane', requestId: 'pi-crew', surface: 'terminal', props: { title: 'crew', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

function world(on: On, brokerDown = false) {
  const values: Record<string, { shape: string; value: unknown }> = {}
  let version = 1
  const clock = mock.clock(on)
  const effects: string[] = []
  let session = 'lead-1'
  let roster: AgentInfo[] = []
  let delivery = true
  let sendWait: (() => Promise<void>) | undefined
  let denySpawn = false
  let rows: SessionMessage[] | { deny: string } = []
  let nextRead: (() => Promise<SessionMessage[] | { deny: string }>) | undefined
  let nextRoster: (() => Promise<AgentInfo[]>) | undefined
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version } }))
  on('state.set', (_, e) => {
    const event = e as { key: string; value: { shape: string; value: unknown } }
    values[event.key] = event.value
    return { value: { isSet: true, version: ++version } }
  })
  on('session.id', () => ({ value: session }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', async () => ({ value: nextRoster ? await nextRoster() : roster }))
  on('agent.spawn', () => denySpawn ? { deny: 'native refusal' } : { model: 'deepseek', agentId: 'native-a' })
  on('session.send', async (_, e) => { effects.push('native-send:' + e.text); if (sendWait) await sendWait(); return delivery ? { isDelivered: true } : { isDelivered: false, reason: 'gone' } })
  on('session.receive', (_, e) => ({ text: e.text }))
  on('session.messages', async (_, e) => {
    effects.push('conversation:' + e.agentId)
    return { value: nextRead ? await nextRead() : rows }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.submit', (_, e) => { effects.push('prompt'); return { text: e.text } })
  for (const event of ['tool.register', 'command.register', 'ui.status', 'ui.log', 'ui.toast'] as const) on(event, () => ({ value: undefined }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'sh' ? 'probe-pane' : '{"ok":true}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('process.spawn', async function* () {
    if (brokerDown) return { value: { code: 1, signal: null } }
    yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'ready', workers: [], feed: [], lead: { id: 'lead', name: 'Lead' }, agtermSession: null }) + '\n' }
    await clock.sleep(86_400_000)
    return { value: { code: 0, signal: null } }
  })
  return {
    clock, effects,
    crew: () => values.claude?.value as ClaudeCrew,
    view: () => values.claudeView?.value as ClaudeView,
    roster: (value: AgentInfo[]) => { roster = value },
    session: (value: string) => { session = value },
    delivery: (value: boolean) => { delivery = value },
    sendWait: (value: () => Promise<void>) => { sendWait = value },
    denySpawn: () => { denySpawn = true },
    rows: (value: SessionMessage[] | { deny: string }) => { rows = value },
    read: (value: () => Promise<SessionMessage[] | { deny: string }>) => { nextRead = value },
    list: (value: () => Promise<AgentInfo[]>) => { nextRoster = value },
  }
}
async function lead($: Engine, w: ReturnType<typeof world>) {
  await $.session.start({ cwd: '/probe', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}
async function worker($: Engine, w: ReturnType<typeof world>) {
  w.roster([agent])
  await $.agent.spawn(spawn)
}
async function select($: Engine) {
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'claude-native-a' })
  await ui.unmount()
}

test('native spawn records an assignment while a resume preserves its identity and original assignment', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  expect(w.crew().workers[0]).toMatchObject({ id: 'native-a', generation: 1, task: spawn.prompt, model: 'deepseek' })
  await $.agent.spawn({ ...spawn, tool_use_id: '', prompt: 'Follow-up, not a replacement assignment', resume: { agentId: 'native-a' } })
  expect(w.crew().workers[0]?.generation).toBe(1)
  expect(w.crew().workers[0]?.task).toBe(spawn.prompt)
  expect(w.crew().messages.length).toBe(1)
  expect(w.effects).toEqual([])
})

test('a denied native spawn remains denied and creates no assignment or prompt', async ($, on) => {
  const w = world(on)
  await lead($, w)
  w.denySpawn()
  expect(await $.agent.spawn(spawn)).toEqual({ deny: 'native refusal' })
  expect(w.crew().workers).toEqual([])
  expect(w.crew().messages).toEqual([])
  expect(w.effects).toEqual([])
})

test('lead and worker sends are observed once, repeated text is legitimate, and delivery failure records nothing', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  const origin = { kind: 'model' } as const
  await $.session.send({ to: 'api', text: 'same', origin })
  await $.session.send({ to: 'main', text: 'same', origin, agentId: agent.id })
  await $.session.send({ to: 'main', text: 'same', origin, agentId: agent.id })
  await $.session.receive({ text: 'same', origin: { kind: 'peer', teammate: 'api', isVerified: true } })
  w.delivery(false)
  expect(await $.session.send({ to: 'api', text: 'failed', origin })).toMatchObject({ isDelivered: false })
  expect(w.crew().messages.map(m => [m.kind, m.sender, m.text])).toEqual([
    ['assignment', 'lead', spawn.prompt], ['message', 'lead', 'same'], ['message', 'worker', 'same'], ['message', 'worker', 'same'],
  ])
  expect(w.crew().messages.slice(1).every(m => m.delivery === 'queued')).toBe(true)
  expect(w.effects).toEqual(['native-send:same', 'native-send:same', 'native-send:same', 'native-send:failed'])
})

test('external teammate messages keep unverified provenance; unrelated deliveries are not attributed', async ($, on) => {
  const w = world(on)
  await lead($, w)
  w.roster([{ ...agent, id: 'api@team', teammateId: 'api@team' }])
  await w.clock.advance(5_000)
  for (const [teammate, text] of [['api', 'external message'], ['stranger', 'unrelated']] as const) await $.session.receive({ text, origin: { kind: 'peer', teammate, isVerified: false } })
  expect(w.crew().messages.map(m => [m.text, m.delivery])).toEqual([['external message', 'unverified']])
  expect(w.effects).toEqual([])
})

test('native reports use turn identity, preserve failed outcomes and never enter Pi delivery', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  w.roster([{ ...agent, status: 'failed' }])
  const event = { agentId: agent.id, turnId: 'turn-1', answer: 'Partial result', durationMs: 5, isAborted: false, reason: 'error' } as const
  expect(await $.turn.complete(event)).toMatchObject({ text: 'Partial result' })
  await $.turn.complete(event)
  expect(w.crew().workers[0]?.status).toBe('failed')
  expect(w.crew().messages.filter(m => m.kind === 'result').length).toBe(1)
  expect(w.effects).toEqual([])
})

test('confirmed replacement spawns cannot reuse the previous generation thread', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  const initial = await $.ui.mount(PANE)
  await initial.press({ key: 'claude-native-a' })
  await initial.unmount()
  await $.agent.spawn({ ...spawn, tool_use_id: 'spawn-2', prompt: 'Replacement task' })
  expect(w.crew().workers[0]?.generation).toBe(2)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/Worker changed/)
  expect((await ui.find({ type: 'Box' }))?.text).not.toMatch(/Review parser safely/)
  await ui.unmount()
})

test('native browsing is read-only and a denied worker read never shows the main conversation', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  await select($)
  w.rows({ deny: 'agent runs in another process' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'claude-conversation' })
  await ui.unmount()
  const refreshed = await $.ui.mount(PANE)
  expect((await refreshed.find({ type: 'Box' }))?.text).toMatch(/Conversation unavailable.*another process/)
  expect(w.effects).toEqual(['conversation:native-a'])
  await refreshed.unmount()
})

test('conversation reads are explicit bounded snapshots, not model context or prompt-target switches', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  await select($)
  w.rows(Array.from({ length: 70 }, (_, i) => ({ role: 'assistant' as const, text: 'row ' + i, toolUses: [] })))
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'claude-conversation' })
  expect(w.view().conversation?.length).toBe(50)
  expect(w.view().conversation?.[0]?.text).toBe('row 20')
  await w.clock.advance(15_000)
  expect(w.effects).toEqual(['conversation:native-a'])
  await ui.unmount()
})

test('pinned native messages stay frozen until latest is selected', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  await select($)
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'claude-conversation' })
  await $.session.send({ to: 'api', text: 'new message', origin: { kind: 'model' } })
  expect(w.view().messages.length).toBe(1)
  expect(w.view().newer.length).toBe(1)
  await ui.press({ key: 'claude-latest' })
  expect(w.view().messages.length).toBe(2)
  expect(w.view().newer).toEqual([])
  expect(w.view().conversation).toBeUndefined()
  await ui.unmount()
})

test('conversation changes without session.start hide and then reset old native state', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  await select($)
  w.session('lead-2')
  w.roster([])
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Box' }))?.text).not.toMatch(/Review parser safely/)
  await ui.unmount()
  await w.clock.advance(5_000)
  expect(w.crew().sessionId).toBe('lead-2')
  expect(w.crew().messages).toEqual([])
  expect(w.view().selected).toBeUndefined()
})

test('a late conversation snapshot cannot reopen an old selection', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  await select($)
  let resolve!: (rows: SessionMessage[]) => void
  let reading!: () => void
  const started = new Promise<void>(r => { reading = r })
  w.read(() => { reading(); return new Promise(r => { resolve = r }) })
  const ui = await $.ui.mount(PANE)
  const pending = ui.press({ key: 'claude-conversation' })
  await started
  await ui.press({ key: 'claude-back' })
  resolve([{ role: 'assistant', text: 'OLD SNAPSHOT', toolUses: [] }])
  await pending
  expect(w.view().selected).toBeUndefined()
  expect(w.view().conversation).toBeUndefined()
  await ui.unmount()
})

test('an unavailable native roster is visible while the Pi observer remains available', async ($, on) => {
  const w = world(on)
  await lead($, w)
  w.list(async () => { throw new Error('roster unavailable') })
  await w.clock.advance(5_000)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/Claude roster unavailable/)
  expect(w.effects).toEqual([])
  await ui.unmount()
})


test('a successful spawn retains metadata even before the roster publishes the agent', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await $.agent.spawn(spawn)
  expect(w.crew().workers[0]).toMatchObject({ id: agent.id, task: spawn.prompt, model: 'deepseek' })
  expect(w.crew().messages[0]?.kind).toBe('assignment')
})

test('a send finishing after replacement cannot attach to the replacement generation', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(r => { entered = r })
  w.sendWait(() => { entered(); return new Promise(r => { release = r }) })
  const pending = $.session.send({ to: 'api', text: 'OLD RUN MESSAGE', origin: { kind: 'model' } })
  await started
  await $.agent.spawn({ ...spawn, tool_use_id: 'spawn-2', prompt: 'Replacement' })
  release()
  await pending
  expect(w.crew().messages.some(m => m.text === 'OLD RUN MESSAGE')).toBe(false)
})

test('a late roster reply cannot restore agents from a previous conversation', async ($, on) => {
  const w = world(on)
  await lead($, w)
  await worker($, w)
  let release!: (agents: AgentInfo[]) => void
  let entered!: () => void
  const started = new Promise<void>(r => { entered = r })
  w.list(() => { entered(); return new Promise(r => { release = r }) })
  const pending = $.turn.start({ agentId: agent.id, text: '', turnId: 'late-turn' })
  await started
  w.session('lead-2')
  release([agent])
  await pending
  w.list(async () => [])
  await w.clock.advance(5_000)
  expect(w.crew().sessionId).toBe('lead-2')
  expect(w.crew().workers).toEqual([])
  expect(w.crew().messages).toEqual([])
})

test('nested assignments name the parent rather than pretending the lead assigned them', async ($, on) => {
  const w = world(on)
  await lead($, w)
  w.roster([{ ...agent, parentId: 'parent-a' }])
  await $.agent.spawn({ ...spawn, parentAgentId: 'parent-a' })
  expect(w.crew().messages[0]?.sender).toBe('parent')
})

test('noninteractive sessions do not start a native observer or Pi bridge', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/probe', surface: 'terminal', isInteractive: false })
  w.roster([agent])
  await $.agent.spawn(spawn)
  expect(w.crew()).toBeUndefined()
  expect(w.effects).toEqual([])
})

for (const [placement, width] of [['dock', 40], ['dock', 100], ['inline', 24]] as const) {
  test('native thread controls work in ' + placement + ' at ' + width + ' columns', async ($, on) => {
    const w = world(on)
    await lead($, w)
    await worker($, w)
    await select($)
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement, bodyColumns: width } })
    for (const key of ['claude-back', 'claude-latest', 'claude-conversation']) expect(await ui.find({ key })).toBeTruthy()
    expect(await ui.find({ type: 'Input' })).toBeFalsy()
    expect(w.effects).toEqual([])
    await ui.unmount()
  })
}

test('native workers remain observable while the Pi bridge is restarting', async ($, on) => {
  const w = world(on, true)
  await lead($, w)
  await worker($, w)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/Review parser safely/)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/Claude workers/)
  expect(w.effects).toEqual([])
  await ui.unmount()
})
