// A read-only status summary. The lead, not the observer, handles worker messages.
import type { On } from 'claude-code'
import { openPane, readCrew } from './crew'
import { observerBand } from './model'

export const registerBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { workers } = await readCrew($)
    if (e.props.hasSurvey || workers.length === 0) return next(e)
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const hotkey = e.props.bodyColumns >= 3 ? 'c' : undefined
    const label = observerBand(workers, Math.max(0, e.props.bodyColumns - (hotkey ? 3 : 0)))
    return <Box flexDirection="column">
      {hotkey ? <Button plain hotkey={hotkey} key="crew" label={label} onPress={() => openPane($)} /> : <Text>{label}</Text>}
      {below}
    </Box>
  })
