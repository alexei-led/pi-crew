// The band above the prompt: counts only, and the question waiting longest. Each part opens the pane where it points.
import type { On } from 'claude-code'

import { openPane, readCrew } from './crew'
import { TONE, bandLayout, nextQuestion, tally, toneProps } from './model'
import type { BandChip } from './model'

const chipTone = (key: BandChip['key']) => (key === 'unread' ? undefined : TONE[key])

export const registerBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { workers: ws, now } = await readCrew($)
    if (e.props.hasSurvey || ws.length === 0) return next(e)
    // Another plugin's band (crew-net's team line) draws under this one: both call next and stack.
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const q = nextQuestion(ws)
    const { crew, separator, question, chips } = bandLayout(tally(ws), q, now, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="nowrap">
          <Button plain hotkey={crew.hotkey} key="crew" label={crew.label} onPress={() => openPane($, { tab: 'crew', filter: 'all' })} />
          {q && question && <Text dimColor>{separator}</Text>}
          {q && question && <Button plain hotkey="a" key="next" label="answer oldest question" onPress={() => openPane($, { tab: 'inbox', filter: 'ask' }, q)}>
            <Text color={TONE.ask}>{question}</Text>
          </Button>}
          {chips.map(c => <Box key={c.key} flexDirection="row">
            <Text dimColor>{separator}</Text>
            <Button plain hotkey={c.hotkey} key={c.key} label={c.label} onPress={() => openPane($, { tab: c.tab, filter: c.filter })}>
              <Text {...toneProps(chipTone(c.key))}>{c.label}</Text>
            </Button>
          </Box>)}
        </Box>
        {below}
      </Box>
    )
  })
