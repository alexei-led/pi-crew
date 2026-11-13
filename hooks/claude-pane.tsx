import type { EngineInterface as Engine } from 'claude-code'
import type { ClaudeMsg, ClaudeWorker } from '../types'
import { closeClaude, conversationClaude, expandClaude, latestClaude, openClaude, readClaude } from './claude'
import { setView } from './crew'
import { age, claudeLabel, clampText, clip, oneLine } from './model'

type UI = ReturnType<Engine['ui']['resolve']>
type Native = Awaited<ReturnType<typeof readClaude>>

async function open($: Engine, worker: ClaudeWorker) {
  await setView($, { sel: undefined, history: undefined, newer: [], error: undefined })
  await openClaude($, worker)
}

export function claudeRows($: Engine, ui: UI, c: Native, cols: number, focus: boolean) {
  const { Box, Button, Text } = ui
  return <Box flexDirection="column">
    <Text bold>Claude workers</Text>
    {c.crew.error && <Text color="warning">{'Claude roster unavailable: ' + c.crew.error}</Text>}
    {c.crew.workers.map((w, i) => <Box key={'claude-row-' + w.id} flexDirection="column" marginBottom={1}>
      <Button plain key={'claude-' + w.id} autoFocus={focus && i === 0 ? true : undefined} label={w.name ?? w.description} onPress={() => open($, w)}>
        <Text>{clip('Claude · ' + (w.name ?? w.description) + ' · ' + claudeLabel(w), cols)}</Text>
      </Button>
      <Text>{clip(w.task ? oneLine(w.task) : w.description + ' · assignment not observed', cols)}</Text>
      {w.parentId && <Text dimColor>{clip('Parent agent ' + w.parentId, cols)}</Text>}
    </Box>)}
  </Box>
}

function excerpt($: Engine, ui: UI, c: Native, text: string, key: string, cols: number) {
  const { Box, Button, Text } = ui
  const body = clampText(text, 5, cols)
  const expanded = c.view.expanded.includes(key)
  return <Box flexDirection="column">
    <Text>{expanded ? text : body.text + (body.more ? ' …' : '')}</Text>
    {body.more && <Button plain key={'claude-expand-' + key} label={expanded ? 'collapse' : 'expand'} onPress={() => expandClaude($, key)} />}
  </Box>
}

function message($: Engine, ui: UI, c: Native, w: ClaudeWorker, m: ClaudeMsg, cols: number, now: number) {
  const { Box, Text } = ui
  const name = w.name ?? w.description
  const actor = m.sender !== 'worker' ? (m.sender === 'parent' ? 'Parent agent' : 'Lead') + ' → ' + name : m.kind === 'result' ? name + ' · turn report' : name + ' → Lead'
  const note = m.kind === 'assignment' ? 'assignment' : m.delivery === 'queued' ? 'queued, not a read receipt' : m.delivery === 'unverified' ? 'claimed sender · unverified mailbox' : ''
  return <Box key={'claude-msg-' + m.id} flexDirection="column" marginBottom={1}>
    <Text>{clip(actor + (note ? ' · ' + note : '') + ' · ' + age(m.at, now), cols)}</Text>
    {excerpt($, ui, c, m.text, m.id, cols)}
  </Box>
}

export function claudeThread($: Engine, ui: UI, c: Native, cols: number, now: number) {
  const { Box, Button, Text } = ui
  const selected = c.view.selected
  const w = c.crew.workers.find(w => w.id === selected?.id && w.generation === selected.generation)
  return <Box flexDirection="column">
    <Button plain hotkey="b" key="claude-back" label="Crew" onPress={() => closeClaude($)} />
    {!w || selected?.sessionId !== c.crew.sessionId ? <Text>Worker changed or is no longer retained. Open it again from Crew.</Text> : <Box flexDirection="column">
      <Text bold>{clip('Claude · ' + (w.name ?? w.description) + ' · ' + claudeLabel(w), cols)}</Text>
      {excerpt($, ui, c, w.task ?? 'Assignment not observed.', 'task', cols)}
      <Text dimColor>{clip(w.type + (w.model ? ' · ' + w.model : ''), cols)}</Text>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        <Box marginRight={2}><Button plain hotkey="l" key="claude-latest" label={c.view.newer.length ? c.view.newer.length + ' newer · latest messages' : 'latest messages'} onPress={() => latestClaude($)} /></Box>
        <Button plain hotkey="c" key="claude-conversation" label="conversation snapshot" onPress={() => conversationClaude($)} />
      </Box>
      {c.view.error && <Text color="warning">{c.view.error}</Text>}
      {c.view.loading && <Text dimColor>Loading conversation snapshot…</Text>}
      {c.view.conversation ? <Box flexDirection="column">
        <Text dimColor>Read-only snapshot · latest 50 rows · tool names only · refresh explicitly.</Text>
        {c.view.conversation.map((m, i) => <Box key={'claude-conversation-' + i} flexDirection="column" marginBottom={1}>
          <Text dimColor>{m.role === 'assistant' ? 'Worker' : 'Received context'}</Text>
          {m.text && excerpt($, ui, c, m.text, 'conversation-' + c.view.request + '-' + i, cols)}
          {m.tools.length > 0 && <Text dimColor>{clip('Tools: ' + m.tools.join(', '), cols)}</Text>}
        </Box>)}
        {c.view.conversation.length === 0 && <Text dimColor>No visible conversation rows.</Text>}
      </Box> : <Box flexDirection="column">
        <Text dimColor>Recent observed communication · read-only · not a complete archive.</Text>
        <Text dimColor>History before observation or after expiry may be unavailable. Reports do not verify work.</Text>
        {c.view.messages.map(m => message($, ui, c, w, m, cols, now))}
        {c.view.messages.length === 0 && <Text dimColor>No messages observed for this worker.</Text>}
      </Box>}
    </Box>}
  </Box>
}
