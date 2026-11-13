import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const props = { title: 'crew', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const PANE = { plugin: 'pi-crew', component: 'Pane', requestId: 'pi-crew', props, surface: 'terminal' } as const
const native = { id: 'native-api', generation: 1, name: 'api', description: 'Native task', type: 'general-purpose', status: 'running' as const, present: true, startedAt: 0, lastAt: 0, task: 'Review the parser' }
function world(on: On) {
  const values: Record<string, { shape: string; value: unknown }> = {
    workers: { shape: 'workers-1', value: [{ name: 'api', id: 'pi-api', n: 1, cwd: '/w', model: 'pi-model', state: 'work', unread: 1, startedAt: 0, lastAt: 0 }] },
    claude: { shape: 'claude-1', value: { sessionId: 'conversation-1', workers: [native], messages: [], sequence: 0 } },
  }
  let version = 1
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version } }))
  on('state.set', (_, e) => {
    const event = e as { key: string; value: { shape: string; value: unknown } }
    values[event.key] = event.value
    return { value: { isSet: true, version: ++version } }
  })
  mock.clock(on)
  on('session.id', () => ({ value: 'conversation-1' }))
  on('agent.list', () => ({ value: [native] }))
  return values
}
test('the observer shows Pi and native Claude workers with the same name separately', async ($, on) => {
  world(on)
  const ui = await $.ui.mount(PANE)
  const text = (await ui.find({ type: 'Box' }))?.text ?? ''
  expect(text).toMatch(/Pi workers/)
  expect(text).toMatch(/Claude workers/)
  expect(text).toMatch(/Review the parser/)
  expect(await ui.find({ key: 'w-api' })).toBeTruthy()
  expect(await ui.find({ key: 'claude-native-api' })).toBeTruthy()
  await ui.unmount()
})
