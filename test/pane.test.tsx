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
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version: 1 } }))
  on('clock.now', () => ({ value: 60_000 }))
}

test('the band counts states and shows the oldest question', async ($, on) => {
  seed(on, { workers: { shape: 'workers-1', value: WORKERS } })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /needs you/ }))?.text).toBe('◆ 1 needs you')
  expect((await ui.find({ type: 'Button', key: 'next' }))?.text).toMatch(/\? 1 api: Use Postgres\?/)
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
    view: { shape: 'view-2', value: { tab: 'inbox', filter: 'all', sel: 'api', showAll: false, collapsed: [] } },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Use Postgres\?/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'yes' })).toBeTruthy()
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
