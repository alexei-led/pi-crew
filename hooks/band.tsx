// Exceptional delivery state only. No questions, reports, or routine counts belong in this strip.
import type { On } from 'claude-code'
import { openPane, readDelivery } from './crew'
import { clip, deliveryWarning } from './model'

export const registerBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const label = deliveryWarning(await readDelivery($))
    if (e.props.hasSurvey || !label || e.props.bodyColumns < 1) return next(e)
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const hotkey = e.props.bodyColumns > 3
    return <Box flexDirection="column">
      {hotkey ? <Button plain hotkey="c" key="crew" label={clip(label, e.props.bodyColumns - 3)} onPress={() => openPane($)} /> : <Text>{clip(label, e.props.bodyColumns)}</Text>}
      {below}
    </Box>
  })
