import { expect, test } from 'claude-code/testing'

const props = {
  title: 'Pi crew',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const PANE = { plugin: 'pi-crew', component: 'Pane', requestId: 'pi-crew', props } as const
const BAND = {
  plugin: 'pi-crew',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

const worker = (name: string, n: number, more: Record<string, unknown> = {}) => ({
  name, n, id: name, cwd: '/w', model: 'router/openai-work', state: 'work', unread: 0, startedAt: 0, lastAt: 0, ...more,
})
const msg = (i: number, worker: string, kind = 'report') => ({ id: `${worker}-${i}`, at: i, kind, text: `${worker} message ${i}`, worker, peer: worker })

const WORKERS = [
  worker('api', 1, { state: 'ask', unread: 1, ask: { id: 'q', at: 0, text: 'Use Postgres?' } }),
  worker('web', 2, { group: 'ui' }),
  worker('old', 3, { state: 'gone' }),
]
const FEED = [...Array.from({ length: 6 }, (_, i) => msg(i, 'api')), msg(9, 'api', 'ask')]

function seed(on: Parameters<Parameters<typeof test>[1]>[1], values: Record<string, { shape: string; value: unknown }>) {
  let version = 1
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version } }))
  on('state.set', (_, e) => {
    const event = e as { key: string; value: { shape: string; value: unknown } }
    values[event.key] = event.value
    return { value: { isSet: true, version: ++version } }
  })
  on('clock.now', () => ({ value: 60_000 }))
}

test('the band counts states and shows the oldest question', async ($, on) => {
  seed(on, { workers: { shape: 'workers-1', value: WORKERS } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'next' }))?.text).toMatch(/◆ 1 api 1m: Use Postgres\?/)
  expect(await ui.find({ type: 'Button', key: 'gone' })).toBeTruthy()
  await ui.unmount()
})

test('the band stays hidden with no workers', async ($, on) => {
  seed(on, {})
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'crew' })).toBeFalsy()
  await ui.unmount()
})

test('the inbox lists the asking worker first', async ($, on) => {
  seed(on, { workers: { shape: 'workers-1', value: WORKERS } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('w-'))
  expect(rows.map(r => r.key)).toEqual(['w-api', 'w-web', 'w-old'])
  await ui.unmount()
})

test('a worker shows its question and only the latest three messages', async ($, on) => {
  seed(on, {
    workers: { shape: 'workers-1', value: WORKERS },
    feed: { shape: 'feed-1', value: FEED },
    view: { shape: 'view-3', value: { tab: 'inbox', filter: 'all', sel: 'api', showAll: false, questionExpanded: false, collapsed: [] } },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Use Postgres\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'yes' })).toBeTruthy()
  expect(await ui.find({ key: 'question-expand' })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /^latest/ }))?.text).toMatch(/latest 3 of 7/)
  expect(await ui.find({ type: 'Text', text: /api message 4/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /api message 3/ })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'more' })).toBeTruthy()
  await ui.unmount()
})

test('a stored view of another shape falls back to the inbox', async ($, on) => {
  seed(on, {
    workers: { shape: 'workers-1', value: WORKERS },
    view: { shape: 'view-1', value: { tab: 'feed', filter: 'all', sel: 'api', showAll: true, collapsed: [] } },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'yes' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'tab-inbox' })).toBeTruthy()
  await ui.unmount()
})


for (const sel of [undefined, 'api', 'missing']) {
  for (const [key, hotkey] of [['quit', 'q'], ['close', 'x']]) {
    test(`${hotkey} closes ${sel ?? 'list'}`, async ($, on) => {
      seed(on, {
        workers: { shape: 'workers-1', value: WORKERS },
        view: { shape: 'view-3', value: { tab: 'inbox', filter: 'all', sel, showAll: false, questionExpanded: false, collapsed: [] } },
      })
      let closed = ''
      on('ui.close', (_, e) => { closed = e.id; return { value: undefined } })
      const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
      expect((await ui.find({ type: 'Button', key }))?.props.hotkey).toBe(hotkey)
      await ui.press({ key })
      expect(closed).toBe('pi-crew')
      await ui.unmount()
    })
  }
}

test('word filters use a n w i s', async ($, on) => {
  const values = { workers: { shape: 'workers-1', value: [...WORKERS, worker('quiet', 4, { state: 'idle' })] } }
  seed(on, values)
  for (const [filter, key, label, names] of [
    ['all', 'a', 'all 4', ['w-api', 'w-web', 'w-quiet', 'w-old']],
    ['ask', 'n', '◆ needs you 1', ['w-api']],
    ['work', 'w', '● working 1', ['w-web']],
    ['idle', 'i', '○ idle 1', ['w-quiet']],
    ['gone', 's', '✕ stopped 1', ['w-old']],
  ] as const) {
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const chip = await ui.find({ type: 'Button', key: `f-${filter}` })
    expect(chip?.props.hotkey).toBe(key)
    expect(chip?.text).toMatch(new RegExp(label))
    await ui.press({ key: `f-${filter}` })
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('w-'))
    expect(rows.map(r => r.key)).toEqual([...names])
    expect(rows[0]?.props.autoFocus).toBe(true)
    await ui.unmount()
  }
})

for (const state of ['work', 'gone']) {
  test(`${state} requires s then c, and other actions cancel`, async ($, on) => {
    seed(on, {
      workers: { shape: 'workers-1', value: [worker('api', 1, { state })] },
      view: { shape: 'view-3', value: { tab: 'crew', filter: 'all', sel: 'api', showAll: false, questionExpanded: false, collapsed: [] } },
    })
    let attempts = 0
    on('ui.toast', () => { attempts++; return { value: undefined } })
    let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'confirm' })).toBeFalsy()
    expect((await ui.find({ key: 'stop' }))?.props.hotkey).toBe('s')
    await ui.press({ key: 'stop' })
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(attempts).toBe(0)
    expect((await ui.find({ key: 'confirm' }))?.props.hotkey).toBe('c')
    expect((await ui.find({ key: 'confirm' }))?.props.autoFocus).toBeFalsy()
    expect((await ui.find({ key: 'cancel' }))?.props.hotkey).toBeUndefined()
    await ui.press({ key: 'cancel' })
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'confirm' })).toBeFalsy()
    await ui.press({ key: 'stop' })
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(attempts).toBe(0)
    await ui.press({ key: 'confirm' })
    expect(attempts).toBe(1)
    await ui.unmount()
    ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: 'confirm' })).toBeFalsy()
    await ui.unmount()
  })
}

test('a cut question expands and collapses with d', async ($, on) => {
  const text = 'question '.repeat(100) + 'THE END'
  seed(on, {
    workers: { shape: 'workers-1', value: [worker('api', 1, { state: 'ask', ask: { id: 'q', at: 0, text } })] },
    view: { shape: 'view-3', value: { tab: 'crew', filter: 'ask', sel: 'api', showAll: false, questionExpanded: false, collapsed: [] } },
  })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /THE END/ })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: / …$/ })).toBeTruthy()
  expect((await ui.find({ key: 'question-expand' }))?.props.hotkey).toBe('d')
  await ui.press({ key: 'question-expand' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /THE END/ }))?.text).toBe(text)
  await ui.press({ key: 'question-expand' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /THE END/ })).toBeFalsy()
  await ui.unmount()
})

test('40 columns clips long worker tags before the age and preview', async ($, on) => {
  const name = 'a'.repeat(32)
  seed(on, { workers: { shape: 'workers-1', value: [worker(name, 1)] } })
  const ui = await $.ui.mount({ ...PANE, props: { ...props, bodyColumns: 40, placement: 'inline' }, surface: 'terminal' })
  const row = await ui.find({ key: `w-${name}` })
  expect(row?.text).toMatch(/^● 1 a+…/)
  expect((row?.text ?? '').length <= 40).toBe(true)
  await ui.unmount()
})

test('the band hides zero chips and exposes c a u navigation', async ($, on) => {
  seed(on, { workers: { shape: 'workers-1', value: [WORKERS[0]] } })
  const opens: Array<{ id: string; closeOnEscape?: boolean }> = []
  on('ui.open', (_, e) => { opens.push(e); return { value: { isPlaced: true } } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (const key of ['work', 'idle', 'gone']) expect(await ui.find({ type: 'Button', key })).toBeFalsy()
  for (const [key, hotkey] of [['crew', 'c'], ['next', 'a'], ['unread', 'u']]) {
    expect((await ui.find({ type: 'Button', key }))?.props.hotkey).toBe(hotkey)
    await ui.press({ key })
  }
  expect(opens.map(e => [e.id, e.closeOnEscape])).toEqual([['pi-crew', true], ['pi-crew', true], ['pi-crew', true]])
  expect((await ui.find({ key: 'next' }))?.props.dimColor).toBeFalsy()
  await ui.unmount()
})

test('the narrow band drops secondary chips before the question', async ($, on) => {
  seed(on, { workers: { shape: 'workers-1', value: WORKERS } })
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 40 }, surface: 'terminal' })
  expect(await ui.find({ key: 'work' })).toBeFalsy()
  expect((await ui.find({ key: 'next' }))?.text).toMatch(/^◆ 1 api 1m:/)
  const tree = await ui.findAll({ type: 'Button' })
  const width = tree.reduce((n, b) => n + b.text.length + (b.props.hotkey ? 3 : 0), (tree.length - 1) * 3)
  expect(width <= 40).toBe(true)
  await ui.unmount()
})

test('/crew opens an Escape-closeable pane', async ($, on) => {
  seed(on, {})
  let escape: boolean | undefined
  on('ui.open', (_, e) => { escape = e.closeOnEscape; return { value: { isPlaced: true } } })
  await $.command.run({ command: 'crew' })
  expect(escape).toBe(true)
})

test('back keeps the Crew tab and filter, and disarms stop', async ($, on) => {
  const values = {
    workers: { shape: 'workers-1', value: WORKERS },
    view: { shape: 'view-3', value: { tab: 'crew', filter: 'ask', sel: 'api', showAll: false, questionExpanded: false, collapsed: [], confirmStop: 'api' } },
  }
  seed(on, values)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back' })
  expect(values.view.value).toMatchObject({ tab: 'crew', filter: 'ask' })
  expect(values.view.value.sel).toBeUndefined()
  expect(values.view.value.confirmStop).toBeUndefined()
  await ui.unmount()
})

test('done messages are neutral, and narrow detail keeps actions separate from identity', async ($, on) => {
  const name = 'a'.repeat(32)
  seed(on, {
    workers: { shape: 'workers-1', value: [worker(name, 1, { agtermSession: 'session' })] },
    feed: { shape: 'feed-1', value: [msg(1, name, 'done')] },
    view: { shape: 'view-3', value: { tab: 'inbox', filter: 'all', sel: name, showAll: false, questionExpanded: false, collapsed: [] } },
  })
  const ui = await $.ui.mount({ ...PANE, props: { ...props, bodyColumns: 40, placement: 'inline' }, surface: 'terminal' })
  for (const key of ['back', 'close', 'open', 'stop', 'quit']) expect(await ui.find({ type: 'Button', key })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: `○ ${name}` }))?.props.color).toBeUndefined()
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.every(b => !b.text.includes(name))).toBe(true)
  expect((await ui.find({ type: 'Input', key: `reply-${name}` }))?.props.placeholder).toBe(`message 1 ${name} · Enter sends`)
  await ui.unmount()
})

test('the wide band labels nonzero states and the compact band shortens them', async ($, on) => {
  seed(on, { workers: { shape: 'workers-1', value: [worker('a', 1), worker('b', 2, { state: 'idle' }), worker('c', 3, { state: 'gone' })] } })
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (const [key, label] of [['work', '● 1 working'], ['idle', '○ 1 idle'], ['gone', '✕ 1 stopped']]) expect((await ui.find({ type: 'Button', key }))?.text).toBe(label)
  await ui.unmount()
  ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 50 }, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'work' }))?.text).toBe('●1')
  await ui.unmount()
})

test('the band counts open questions and answers the oldest in ask color', async ($, on) => {
  const values: Record<string, { shape: string; value: unknown }> = {
    workers: { shape: 'workers-1', value: [
      worker('later', 4, { state: 'ask', ask: { id: 'later', at: 30_000, text: 'Another question?' } }),
      WORKERS[0],
    ] },
  }
  seed(on, values)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'next' }))?.text).toBe('◆ 2 · 1 api 1m: Use Postgres?')
  expect((await ui.find({ type: 'Text', text: /^◆ 2 · 1 api/ }))?.props.color).toBe('yellow')
  expect((await ui.find({ type: 'Button', key: 'next' }))?.props.hotkey).toBe('a')
  await ui.press({ key: 'next' })
  expect(values.view?.value).toMatchObject({ tab: 'inbox', filter: 'ask', sel: 'api' })
  await ui.unmount()
})

test('band state colors reinforce the glyphs and words', async ($, on) => {
  seed(on, { workers: { shape: 'workers-1', value: WORKERS } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^◆ 1 api/ }))?.props.color).toBe('yellow')
  expect((await ui.find({ type: 'Text', text: /^● 1 working$/ }))?.props.color).toBe('green')
  expect((await ui.find({ type: 'Text', text: /^✉ 1 new$/ }))?.props.color).toBe('cyan')
  expect((await ui.find({ type: 'Text', text: /^✕ 1 stopped$/ }))?.props.dimColor).toBe(true)
  await ui.unmount()
})
