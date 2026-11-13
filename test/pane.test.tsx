import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const props = { title: 'crew', isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const PANE = { plugin: 'pi-crew', component: 'Pane', requestId: 'pi-crew', props, surface: 'terminal' } as const
const BAND = { plugin: 'pi-crew', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const worker = (name: string, n: number, more: Record<string, unknown> = {}) => ({
  name, n, id: name, agtermSession: name + '-terminal', runId: name + '-run', cwd: '/w', model: 'model', state: 'work', unread: 3, startedAt: 0, lastAt: 0,
  task: { text: 'Implement ' + name, at: 0 }, ...more,
})
const workers = [worker('api', 1, { state: 'ask', ask: { id: 'q', at: 0, text: 'Use Postgres?' } }), worker('web', 2, { group: 'app' }), worker('old', 3, { state: 'gone' })]
const message = (i: number, more: Record<string, unknown> = {}) => ({ id: 'm' + i, at: i, kind: 'report', text: 'report ' + i, worker: 'api', runId: 'api-run', peer: 'api', sender: 'worker', ...more })
const history = { name: 'api', runId: 'api-run', messages: [message(1, { kind: 'out', sender: 'lead', text: 'Use the shared component' }), message(2)], hasOlder: true }
const view = (more: Record<string, unknown> = {}) => ({ collapsed: [], expanded: [], following: true, newer: [], request: 0, ...more })

function world(on: On, options: { selected?: boolean; view?: Record<string, unknown>; workers?: object[] } = {}) {
  const ws = options.workers ?? workers
  const values: Record<string, { shape: string; value: unknown }> = {
    workers: { shape: 'workers-1', value: ws },
    view: { shape: 'view-4', value: view({ ...(options.selected ? { sel: 'api', runId: 'api-run', history } : {}), ...options.view }) },
  }
  let version = 1
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version } }))
  on('state.set', (_, e) => {
    const event = e as { key: string; value: { shape: string; value: unknown } }
    values[event.key] = event.value
    return { value: { isSet: true, version: ++version } }
  })
  const clock = mock.clock(on)
  const calls: Array<Record<string, unknown>> = []
  const pages: object[] = []
  on('session.id', () => ({ value: 'conversation-1' }))
  on('agent.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  for (const event of ['tool.register', 'command.register', 'ui.status', 'ui.log', 'ui.toast'] as const) on(event, () => ({ value: undefined }))
  on('process.run', (_, e) => {
    let stdout = 'pane-1'
    if (e.argv[0] !== 'sh') {
      const req = JSON.parse(e.argv.at(-1) ?? '{}')
      calls.push(req)
      stdout = JSON.stringify({ ok: true, ...(pages.shift() ?? history) })
    }
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'ready', lead: { id: 'lead', name: 'Lead' }, workers: ws, agtermSession: 's', feed: [] }) + '\n' }
    await clock.sleep(86_400_000)
    return { value: { code: 0, signal: null } }
  })
  on('ui.scroll', () => ({}))
  return { values, calls, pages, clock }
}

test('observer overview shows assignments, waiting on lead, and no management controls', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/Implement api/)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/waiting on lead/)
  expect(await ui.find({ type: 'Input' })).toBeFalsy()
  for (const key of ['tab-inbox', 'tab-crew', 'f-ask', 'stop', 'yes', 'no', 'confirm']) expect(await ui.find({ key })).toBeFalsy()
  expect(await ui.find({ key: 'w-api' })).toBeTruthy()
  await ui.unmount()
})

test('a thread names actual actors and does not turn a question into human work', async ($, on) => {
  world(on, { selected: true })
  const ui = await $.ui.mount(PANE)
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).toMatch(/Lead → api/)
  expect(text).toMatch(/api → Lead/)
  expect(text).toMatch(/Use Postgres\?/)
  expect(text).not.toMatch(/you|send yes|send no/)
  expect(await ui.find({ type: 'Input' })).toBeFalsy()
  expect(await ui.find({ key: 'older' })).toBeTruthy()
  await ui.unmount()
})

test('unknown legacy outgoing authors are not relabeled as Lead', async ($, on) => {
  world(on, { selected: true, view: { history: { ...history, messages: [message(1, { kind: 'out', sender: undefined })] } } })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/To api/)
  expect((await ui.find({ type: 'Box' }))?.text).not.toMatch(/Lead → api/)
  await ui.unmount()
})

test('opening and paging a conversation only queries history', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await w.clock.settle()
  let ui = await $.ui.mount(PANE)
  await ui.press({ key: 'w-api' })
  await ui.unmount()
  expect(w.calls.map(c => c.op)).toEqual(['history'])
  w.pages.push({ ...history, messages: [message(0)], hasOlder: false })
  ui = await $.ui.mount(PANE)
  await ui.press({ key: 'older' })
  expect(w.calls.map(c => c.op)).toEqual(['history', 'history'])
  expect(w.calls[1]?.before).toBe('m1')
  expect((w.values.workers?.value as Array<{ unread: number }>)[0]?.unread).toBe(3)
  await ui.unmount()
})

test('DONE check results are evidence, not a claim that tests ran', async ($, on) => {
  world(on, { selected: true, view: { history: { ...history, hasOlder: false, messages: [message(3, { kind: 'done', checks: { ok: false, notes: ['branch mismatch'], at: 1 } })] } } })
  const ui = await $.ui.mount(PANE)
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).toMatch(/DONE reported/)
  expect(text).toMatch(/branch mismatch/)
  expect(text).toMatch(/Does not prove tests ran/)
  await ui.unmount()
})

test('reading history exposes a latest action without altering manager unread state', async ($, on) => {
  world(on, { selected: true, view: { following: false, newer: ['n1', 'n2'] } })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ key: 'latest' }))?.text).toMatch(/2 newer/)
  expect(await ui.find({ type: 'Input' })).toBeFalsy()
  await ui.unmount()
})

test('a respawn does not display the prior run conversation under the new worker', async ($, on) => {
  world(on, { selected: true, workers: [worker('api', 4, { runId: 'replacement' })] })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/restarted/)
  expect((await ui.find({ type: 'Box' }))?.text).not.toMatch(/report 2/)
  await ui.unmount()
})

for (const [placement, width] of [['dock', 40], ['dock', 90], ['inline', 24]] as const) {
  test('observer navigation fits ' + placement + ' at ' + width + ' columns', async ($, on) => {
    world(on, { selected: true })
    const ui = await $.ui.mount({ ...PANE, props: { ...props, placement, bodyColumns: width } })
    expect(await ui.find({ key: 'back' })).toBeTruthy()
    expect(await ui.find({ key: 'latest' })).toBeTruthy()
    expect(await ui.find({ type: 'Input' })).toBeFalsy()
    await ui.unmount()
  })
}

test('an old view shape resets to the observer overview', async ($, on) => {
  const w = world(on)
  w.values.view = { shape: 'view-3', value: { tab: 'inbox', sel: 'api' } }
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ key: 'w-api' })).toBeTruthy()
  expect(await ui.find({ key: 'yes' })).toBeFalsy()
  await ui.unmount()
})

test('the band keeps status but removes unread and answer actions', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(BAND)
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).toMatch(/crew 2/)
  expect(text).toMatch(/waiting/)
  expect(text).not.toMatch(/new|needs you/)
  expect(await ui.find({ key: 'unread' })).toBeFalsy()
  expect(await ui.find({ key: 'next' })).toBeFalsy()
  await ui.unmount()
})

test('the band yields when empty and preserves another plugin band', async ($, on) => {
  world(on, { workers: [] })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>team</Text>
  })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'crew' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: 'team' })).toBeTruthy()
  await ui.unmount()
})

test('/crew opens an Escape-closeable observer pane', async ($, on) => {
  world(on)
  let opened: object | undefined
  on('ui.open', (_, e) => { opened = e; return { value: { isPlaced: true, isFocused: true, requestId: 'pi-crew' } } })
  await $.command.run({ command: 'crew', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(opened).toMatchObject({ id: 'pi-crew', closeOnEscape: true })
})


test('an expired history cursor keeps the snapshot and offers latest instead of silently jumping', async ($, on) => {
  const w = world(on, { selected: true });
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true });
  await w.clock.settle();
  w.pages.push({ ok: false, error: 'history cursor expired' });
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: 'older' });
  await ui.unmount();
  const next = await $.ui.mount(PANE);
  expect((await next.find({ type: 'Box' }))?.text).toMatch(/history cursor expired/);
  expect((await next.find({ type: 'Box' }))?.text).toMatch(/report 2/);
  expect(await next.find({ key: 'latest' })).toBeTruthy();
  expect(w.calls.every(c => c.op === 'history')).toBe(true);
  await next.unmount();
});


test('opening a worker terminal navigates without sending or acknowledging messages', async ($, on) => {
  const w = world(on, { selected: true });
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true });
  await w.clock.settle();
  const ui = await $.ui.mount(PANE);
  await ui.press({ key: 'open' });
  expect(w.calls.at(-1)).toMatchObject({ op: 'focus', name: 'api' });
  expect(w.calls.every(c => c.op === 'history' || c.op === 'focus')).toBe(true);
  expect((w.values.workers?.value as Array<{ unread: number }>)[0]?.unread).toBe(3);
  await ui.unmount();
});

test('long messages expand locally without a transport operation', async ($, on) => {
  const text = 'large message '.repeat(80) + 'END-OF-MESSAGE';
  const w = world(on, { selected: true, view: { history: { ...history, messages: [message(1, { text })] } } });
  let ui = await $.ui.mount(PANE);
  expect((await ui.find({ type: 'Box' }))?.text).not.toMatch(/END-OF-MESSAGE/);
  await ui.press({ key: 'expand-m1' });
  await ui.unmount();
  ui = await $.ui.mount(PANE);
  expect((await ui.find({ type: 'Box' }))?.text).toMatch(/END-OF-MESSAGE/);
  expect(w.calls).toEqual([]);
  await ui.unmount();
});

test('a nonempty crew band stacks with another plugin instead of replacing it', async ($, on) => {
  world(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>team band</Text>
  })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'crew' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'team band' })).toBeTruthy()
  await ui.unmount()
})
