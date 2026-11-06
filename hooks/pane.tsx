// The crew pane: a list of workers (inbox or crew tab) or one worker's thread.
import type { EngineInterface as Engine, On } from 'claude-code'

import type { CrewFilter, CrewMsg, CrewTab, CrewView, CrewWorker } from '../types'
import { PANE, act, closePane, openThread, readCrew, reply, setView, toggleGroup } from './crew'
import {
  COLOR, GLYPH, LABEL, UNREAD, age, clampText, clip, fold, groups, inboxOrder, matches, oneLine, tag, tally, threadOf,
} from './model'

// The transcript keeps every message; the pane shows only each worker's latest few.
const RECENT = 3
const RECENT_MORE = 10

/**
 * What every part of one pane render reads; built once per render and never mutated. `$` stays a separate argument:
 * the engine rejects a `$` stored in an object.
 */
type Ctx = {
  ui: ReturnType<Engine['ui']['resolve']>
  v: CrewView
  ws: CrewWorker[]
  feed: CrewMsg[]
  now: number
  cols: number
  narrow: boolean
  tagWidth: number
}

const glyph = ({ ui: { Text } }: Ctx, w: CrewWorker) => <Text color={COLOR[w.state]}>{GLYPH[w.state]}</Text>

function dismissButton($: Engine, { ui: { Button } }: Ctx) {
  return <Button plain hotkey="x" key="close" role="dismiss" label="×" onPress={() => closePane($)} />
}

function closeHint($: Engine, { ui: { Button } }: Ctx) {
  return <Button plain dimColor hotkey="q" key="quit" label="close" onPress={() => closePane($)} />
}

function backButton($: Engine, { ui: { Button } }: Ctx) {
  return <Button plain hotkey="b" key="back" label="back" onPress={() => setView($, { sel: undefined })} />
}

/** One worker line, clipped to the pane width: marker, tag, age, unread count, then as much preview as fits. */
function workerRow($: Engine, c: Ctx, w: CrewWorker, opts: { indent?: string; autoFocus?: boolean } = {}) {
  const { ui: { Button, Text }, cols, now, tagWidth } = c
  const preview = oneLine(w.state === 'ask' && w.ask ? w.ask.text : (w.last?.text ?? LABEL[w.state]))
  const indent = clip(opts.indent ?? '', Math.max(0, cols - 2))
  const prefix = clip(`${indent}${GLYPH[w.state]} `, cols)
  const unread = w.unread ? clip(` ${UNREAD}${Math.min(w.unread, 99)}`, Math.max(0, cols - prefix.length)) : ''
  const nameWidth = Math.min(tagWidth, Math.max(0, cols - prefix.length - unread.length))
  const name = clip(tag(w), nameWidth).padEnd(nameWidth)
  const room = cols - prefix.length - name.length - unread.length
  const time = room >= 5 ? ` ${clip(age(w.lastAt, now), 4).padStart(4)}` : ''
  const roomLeft = room - time.length
  const excerpt = roomLeft >= 5 ? ` ${clip(preview, roomLeft - 1)}` : ''
  return (
    <Button plain autoFocus={opts.autoFocus ? true : undefined} key={`w-${w.name}`} label={`${tag(w)} ${LABEL[w.state]}`} onPress={() => openThread($, w)}>
      <Text color={COLOR[w.state]}>{prefix}</Text>{name}<Text dimColor>{time}</Text>
      <Text color="cyan">{unread}</Text>
      <Text dimColor={w.state !== 'ask'}>{excerpt}</Text>
    </Button>
  )
}

const MSG_GLYPH: Record<CrewMsg['kind'], string> = { ask: GLYPH.ask, done: GLYPH.idle, report: GLYPH.work, out: '' }
const MSG_COLOR: Record<CrewMsg['kind'], string | undefined> = { ask: COLOR.ask, done: COLOR.idle, report: COLOR.work, out: 'blue' }

/** One thread message: who and when, then its text clamped to `lines`. */
function messageBody(c: Ctx, w: CrewWorker, m: CrewMsg, lines: number) {
  const { ui: { Box, Text }, cols, now } = c
  const mine = m.kind === 'out'
  const body = clampText(m.text, lines, cols - 2)
  const who = mine ? 'you' : `${MSG_GLYPH[m.kind]} ${w.name}`
  return (
    <Box key={m.id} flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={MSG_COLOR[m.kind]}>{who}</Text>
        <Text dimColor>{`  ${age(m.at, now)}${m.kind === 'done' ? ' · done' : ''}`}</Text>
      </Text>
      <Text dimColor={mine}>{`  ${body.text.replace(/\n/g, '\n  ')}${body.more ? ' …' : ''}`}</Text>
    </Box>
  )
}

function missingWorker($: Engine, c: Ctx, name: string) {
  const { ui: { Box, Text } } = c
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">{backButton($, c)}{dismissButton($, c)}</Box>
      {closeHint($, c)}
      <Text dimColor>{`No worker named ${name}.`}</Text>
    </Box>
  )
}

function detailView($: Engine, c: Ctx, w: CrewWorker) {
  const { ui: { Box, Button, Input, Text }, v, feed, now, cols, narrow } = c
  const msgs = threadOf(feed, w.name)
  const { hidden, shown } = fold(msgs, v.showAll ? RECENT_MORE : RECENT)
  const bodyLines = v.showAll ? 8 : 3
  const question = w.ask ? clampText(w.ask.text, narrow ? 4 : 8, Math.max(1, cols - 4)) : undefined
  const confirming = v.confirmStop === w.name
  const gone = w.state === 'gone'
  const canToggleMore = hidden > 0 || v.showAll
  const stopWord = gone ? 'forget' : 'stop'
  const unreadNote = w.unread ? ` · ${UNREAD} ${w.unread} new` : ''
  const hint = [
    'b back',
    canToggleMore ? ' · e more' : '',
    w.agtermSession ? ' · o terminal' : '',
    w.ask && question?.more ? ` · d ${v.questionExpanded ? 'collapse' : 'full'} question` : '',
    w.ask ? ' · y/n send' : '',
    ` · s ${stopWord} · Tab move · Enter activate · Esc/`,
  ].join('')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        {backButton($, c)}
        {dismissButton($, c)}
      </Box>
      <Box flexDirection="row" flexWrap="wrap">
        {w.agtermSession && <Button plain hotkey="o" key="open" label="worker terminal" onPress={async () => {
          await setView($, {})
          await act($, { op: 'focus', name: w.name }, `open ${tag(w)}`)
        }} />}
        <Text> </Text>
        <Button plain hotkey="s" key="stop" label={stopWord} onPress={() => setView($, { confirmStop: confirming ? undefined : w.name })} />
      </Box>
      {confirming && <Box flexDirection="row" flexWrap="wrap">
        <Text>{gone ? `forget ${tag(w)}? removes its record  ` : `stop ${tag(w)}? its session closes and current work ends  `}</Text>
        <Button plain hotkey="c" key="confirm" label="confirm" onPress={async () => {
          await setView($, {})
          if (await act($, { op: 'stop', name: w.name }, `stop ${tag(w)}`)) await setView($, gone ? { sel: undefined } : {})
        }} />
        <Text> </Text><Button plain hotkey="v" key="cancel" label="cancel" onPress={() => setView($, {})} />
      </Box>}
      <Text>{glyph(c, w)}<Text bold>{` ${clip(tag(w), narrow ? Math.max(8, cols - 4) : cols)}`}</Text></Text>
      <Text dimColor>{clip(`${w.group ? `${w.group} · ` : ''}${LABEL[w.state]} · ${age(w.startedAt, now)}`, cols)}</Text>
      <Text dimColor>{clip(`${w.cwd} · ${w.model} · last ${age(w.lastAt, now)}${unreadNote}`, cols)}</Text>
      {w.ask && (
        <Box flexDirection="column" borderStyle="round" borderColor={COLOR.ask} paddingX={1} marginTop={1}>
          <Text color={COLOR.ask} bold>{`${GLYPH.ask} question · ${age(w.ask.at, now)}`}</Text>
          <Text>{v.questionExpanded ? w.ask.text : `${question?.text}${question?.more ? ' …' : ''}`}</Text>
          {question?.more && <Button plain hotkey="d" key="question-expand" label={v.questionExpanded ? 'collapse question' : 'full question'} onPress={() => setView($, { questionExpanded: !v.questionExpanded })} />}
          <Box flexDirection="row" flexWrap="wrap">
            <Button plain hotkey="y" key="yes" label="send yes" onPress={() => reply($, w, 'yes')} />
            <Text>  </Text>
            <Button plain hotkey="n" key="no" label="send no" onPress={() => reply($, w, 'no')} />
            <Text dimColor>  or type an answer below</Text>
          </Box>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {msgs.length === 0 && <Text dimColor>No messages yet.</Text>}
        {msgs.length > 0 && <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>{`latest ${shown.length}${hidden ? ` of ${msgs.length}` : ''} · full text in the transcript  `}</Text>
          {canToggleMore && (
            <Button plain dimColor hotkey="e" key="more" label={v.showAll ? 'less' : 'more'} onPress={() => setView($, { showAll: !v.showAll })} />
          )}
        </Box>}
        {shown.map(m => messageBody(c, w, m, bodyLines))}
      </Box>
      {!gone && (
        <Input key={`reply-${w.name}`} placeholder={`message ${tag(w)} · Enter sends`} submitLabel="send" rows={2} onInput={async () => { if (v.confirmStop) await setView($, {}) }} onSubmit={value => reply($, w, value)} />
      )}
      <Box flexDirection="row" flexWrap="wrap"><Text dimColor>{hint}</Text>{closeHint($, c)}</Box>
    </Box>
  )
}

/** The tally behind a group header: size, then only the nonzero ask, work and unread counts. */
function groupSummary(workers: CrewWorker[]): string {
  const t = tally(workers)
  return [
    `${workers.length}`,
    t.ask ? `${GLYPH.ask}${t.ask}` : '',
    t.work ? `${GLYPH.work}${t.work}` : '',
    t.unread ? `${UNREAD}${t.unread}` : '',
  ].filter(Boolean).join(' · ')
}

function crewList($: Engine, c: Ctx, shown: CrewWorker[]) {
  const { ui: { Box, Button, Text }, v } = c
  const sections = groups(shown).map(g => ({ ...g, folded: v.collapsed.includes(g.name) }))
  const first = sections.find(g => !g.folded)?.workers[0]
  return (
    <Box flexDirection="column">
      {sections.map(g => (
        <Box key={`g-${g.name}`} flexDirection="column">
          <Button
            plain
            key={`g-${g.name}`}
            label={g.name}
            onPress={() => toggleGroup($, g.name)}
          >
            <Text bold>{`${g.folded ? '▸' : '▾'} ${g.name}`}</Text>
            <Text dimColor>{`  ${groupSummary(g.workers)}`}</Text>
          </Button>
          {!g.folded && g.workers.map(w => workerRow($, c, w, { indent: '  ', autoFocus: w === first }))}
        </Box>
      ))}
      {shown.length === 0 && <Text dimColor>No workers match this filter.</Text>}
    </Box>
  )
}

function inboxList($: Engine, c: Ctx, shown: CrewWorker[]) {
  const { ui: { Box, Text } } = c
  const order = inboxOrder(shown)
  return (
    <Box flexDirection="column">
      {order.map((w, i) => workerRow($, c, w, { autoFocus: i === 0 }))}
      {order.length === 0 && <Text dimColor>No workers match this filter.</Text>}
    </Box>
  )
}

function emptyCrew({ ui: { Box, Text } }: Ctx) {
  return (
    <Box flexDirection="column">
      <Text dimColor>No workers yet.</Text>
      <Text dimColor>Ask Claude: "spawn a pi worker named api in ~/project to …"</Text>
    </Box>
  )
}

function listView($: Engine, c: Ctx) {
  const { ui: { Box, Button, Text }, v, ws } = c
  const t = tally(ws)
  const shown = ws.filter(w => matches(w, v.filter))
  const inboxLabel = ['Inbox', t.unread ? `${UNREAD}${t.unread}` : '', t.ask ? `${GLYPH.ask}${t.ask}` : ''].filter(Boolean).join(' ')
  const tabs: Array<[CrewTab, string, string]> = [
    ['inbox', '1', inboxLabel],
    ['crew', '2', `Crew ${t.crew}`],
  ]
  const filters: Array<[CrewFilter, string, string]> = [
    ['all', 'a', `all ${ws.length}`],
    ['ask', 'n', `${GLYPH.ask} needs you ${t.ask}`],
    ['work', 'w', `${GLYPH.work} working ${t.work}`],
    ['idle', 'i', `${GLYPH.idle} idle ${t.idle}`],
    ['gone', 's', `${GLYPH.gone} stopped ${t.gone}`],
  ]
  const body = ws.length === 0 ? emptyCrew(c) : v.tab === 'crew' ? crewList($, c, shown) : inboxList($, c, shown)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between"><Box flexDirection="row" flexWrap="wrap">
        {tabs.map(([id, key, label]) => (
          <Box key={`tab-${id}`} marginRight={2}>
            <Button plain hotkey={key} key={`tab-${id}`} label={label} onPress={() => setView($, { tab: id })}>
              <Text bold={v.tab === id} underline={v.tab === id} dimColor={v.tab !== id}>{label}</Text>
            </Button>
          </Box>
        ))}
      </Box>{dismissButton($, c)}</Box>
      <Box flexDirection="row" flexWrap="wrap" marginBottom={1}>
        {filters.map(([id, key, label]) => (
          <Box key={`f-${id}`} marginRight={1}>
            <Button plain hotkey={key} key={`f-${id}`} label={label} onPress={() => setView($, { filter: id })}>
              <Text inverse={v.filter === id} dimColor={v.filter !== id}>{` ${label} `}</Text>
            </Button>
          </Box>
        ))}
      </Box>
      {body}
      <Box flexDirection="row" flexWrap="wrap"><Text dimColor>1/2 tabs · a n w i s filter · Tab move · Enter activate · Esc/</Text>{closeHint($, c)}</Box>
    </Box>
  )
}

export const registerPane = (on: On) =>
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { view: v, workers: ws, feed: fd, now } = await readCrew($)
    const cols = Math.max(1, e.props.bodyColumns)
    const c: Ctx = {
      ui: $.ui.resolve(e),
      v,
      ws,
      feed: fd,
      now,
      cols,
      narrow: e.props.placement === 'inline' || cols < 60,
      tagWidth: Math.min(18, Math.floor(cols * 0.4), Math.max(5, ...ws.map(w => tag(w).length))),
    }
    if (!v.sel) return listView($, c)
    const w = ws.find(x => x.name === v.sel)
    return w ? detailView($, c, w) : missingWorker($, c, v.sel)
  })
