// Observer-only crew overview and bounded conversation history. The host owns the close mark and scrolling.
import type { EngineInterface as Engine, On } from 'claude-code'
import type { CrewMsg, CrewView, CrewWorker } from '../types'
import { PANE, act, expandMessage, loadHistory, openThread, pauseHistory, readCrew, setView, toggleGroup } from './crew'
import { GLYPH, LABEL, TONE, age, clampText, clip, groups, messageSender, oneLine, tag, toneProps, workerSummary } from './model'

type Ctx = {
  ui: ReturnType<Engine['ui']['resolve']>
  v: CrewView
  now: number
  cols: number
  feed: CrewMsg[]
}

function back($: Engine, { ui: { Button } }: Ctx) {
  return <Button plain hotkey="b" key="back" label="Crew" onPress={async () => {
    await setView($, { sel: undefined, history: undefined, newer: [], error: undefined })
    await $.ui.scroll({ in: PANE, to: 'start' })
  }} />
}

function row($: Engine, c: Ctx, w: CrewWorker, focus: boolean) {
  const { ui: { Box, Button, Text }, cols, now } = c
  const summary = workerSummary(w, c.feed)
  const last = c.feed.findLast(m => m.worker === w.name && m.runId === w.runId)
  const activity = w.ask ? oneLine(w.ask.text) : last ? messageSender(w.name, last) + ': ' + oneLine(last.text) : ''
  return <Box key={'row-' + w.name} flexDirection="column" marginBottom={1}>
    <Button plain key={'w-' + w.name} hotkey={w.n >= 1 && w.n < 10 ? String(w.n) : undefined} autoFocus={focus ? true : undefined} label={tag(w)} onPress={() => openThread($, w)}>
      <Text {...toneProps(TONE[w.state])}>{clip(GLYPH[w.state] + ' ' + w.name + ' · ' + summary.label, Math.max(1, cols - 3))}</Text>
    </Button>
    <Text>{clip(w.task ? oneLine(w.task.text) : 'No recorded assignment', cols)}</Text>
    <Text dimColor>{clip((summary.evidence ? summary.evidence + ' · ' : '') + 'last activity ' + age(w.lastAt, now) + (activity ? ' · ' + activity : ''), cols)}</Text>
  </Box>
}

function excerpt($: Engine, c: Ctx, text: string, key: string, lines: number) {
  const { ui: { Box, Text, Button }, v, cols } = c
  const expanded = v.expanded.includes(key)
  const body = clampText(text, lines, Math.max(1, cols))
  return <Box flexDirection="column">
    <Text>{expanded ? text : body.text + (body.more ? ' …' : '')}</Text>
    {body.more && <Button plain key={'expand-' + key} label={expanded ? 'collapse' : 'expand'} onPress={() => expandMessage($, key)} />}
  </Box>
}

function message($: Engine, c: Ctx, w: CrewWorker, m: CrewMsg) {
  const { ui: { Box, Text, Button }, cols, now, v } = c
  const sender = messageSender(w.name, m)
  const kind = m.kind === 'done' ? 'DONE reported' : m.kind === 'ask' ? 'question' : m.kind === 'out' ? '' : 'progress'
  return <Box key={'msg-' + m.id} flexDirection="column" marginBottom={1}>
    <Text {...toneProps(m.kind === 'ask' ? TONE.ask : undefined)}>{clip(sender + (kind ? ' · ' + kind : '') + ' · ' + age(m.at, now), cols)}</Text>
    {excerpt($, c, m.text, m.id, 5)}
    {m.checks && <Box flexDirection="column">
      <Text color={m.checks.ok ? 'success' : 'warning'}>{clip('Git checks ' + (m.checks.ok ? 'passed' : 'failed') + ' · checked ' + age(m.checks.at, now), cols)}</Text>
      {m.checks.notes.map((note, i) => <Text key={'check-' + i}>{note}</Text>)}
      <Text dimColor>Does not prove tests ran or work is correct.</Text>
    </Box>}
  </Box>
}

function thread($: Engine, c: Ctx, w?: CrewWorker) {
  const { ui: { Box, Button, Text }, v, cols, now } = c
  if (!w || w.runId !== v.runId) return <Box flexDirection="column">
    {back($, c)}<Text>{w ? 'Worker restarted. Open its new run from Crew.' : 'Worker is no longer retained.'}</Text>
  </Box>
  const history = v.history
  return <Box flexDirection="column">
    <Box flexDirection="row" flexWrap="wrap">
      <Box marginRight={2}>{back($, c)}</Box>
      {w.agtermSession && <Button plain hotkey="o" key="open" label="worker terminal" onPress={() => act($, { op: 'focus', name: w.name }, 'open worker terminal')} />}
    </Box>
    <Text bold>{clip(tag(w) + ' · ' + workerSummary(w, history?.messages ?? c.feed).label, cols)}</Text>
    {excerpt($, c, w.task?.text ?? 'No recorded assignment', 'task-' + w.name, 3)}
    <Text dimColor>{clip(w.cwd + ' · ' + w.model, cols)}</Text>
    {w.ask && <Box flexDirection="column"><Text color="warning">{'Waiting on lead · ' + age(w.ask.at, now)}</Text>{excerpt($, c, w.ask.text, 'question-' + w.ask.id, 3)}</Box>}
    <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
      {history?.hasOlder && <Box marginRight={2}><Button plain hotkey="p" key="older" label="older retained messages" onPress={() => loadHistory($, true)} /></Box>}
      <Button plain hotkey="l" key="latest" label={v.following ? 'latest' : v.newer.length ? v.newer.length + ' newer · latest' : 'reading history · latest'} onPress={() => loadHistory($)} />
    </Box>
    {v.error && <Text color="warning">{v.error}</Text>}
    {!history && !v.error && <Text dimColor>Loading recent conversation…</Text>}
    {history && <Box flexDirection="column">
      <Text dimColor>{history.messages.length + ' retained messages shown · read-only'}</Text>
      {!history.hasOlder && <Text dimColor>Start of retained history. Older records may have expired.</Text>}
      {history.messages.map(m => message($, c, w, m))}
      {history.messages.length === 0 && <Text dimColor>No retained messages for this run.</Text>}
    </Box>}
  </Box>
}

export const registerPane = (on: On) => {
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && (e.by < 0 || e.offset < Math.max(0, e.contentRows - e.bodyRows))) await pauseHistory($)
    return next(e)
  })
  return on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { view, workers, feed, now } = await readCrew($)
    const c: Ctx = { ui: $.ui.resolve(e), v: view, feed, now, cols: Math.max(1, e.props.bodyColumns) }
    if (view.sel) return thread($, c, workers.find(w => w.name === view.sel))
    const { Box, Button, Text } = c.ui
    const sections = groups(workers)
    const first = sections.find(g => !view.collapsed.includes(g.name))?.workers[0]
    return <Box flexDirection="column">
      <Text bold>Crew · observer view</Text>
      {workers.length === 0 && <Text dimColor>No workers yet. Ask the lead to delegate a task.</Text>}
      {sections.map(g => <Box key={'group-' + g.name} flexDirection="column">
        {sections.length > 1 && <Button plain key={'group-' + g.name} label={(view.collapsed.includes(g.name) ? '▸ ' : '▾ ') + g.name} onPress={() => toggleGroup($, g.name)} />}
        {!view.collapsed.includes(g.name) && g.workers.map(w => row($, c, w, w === first))}
      </Box>)}
      <Text dimColor>Explore here. Direct agents in their terminals.</Text>
    </Box>
  })
}
