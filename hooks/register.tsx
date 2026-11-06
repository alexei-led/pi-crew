import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { CrewFilter, CrewMsg, CrewTab, CrewView, CrewWorker } from '../types'
import {
  COLOR, GLYPH, LABEL, UNREAD, age, bandQuestion, clampText, clip, fold, groups, inboxOrder, matches, nextQuestion, oneLine, tag,
  tally, threadOf, turnText, type Inbound,
} from './model'

const PLUGIN = 'pi-crew'
const PANE = 'pi-crew'
const TITLE = 'Pi crew'
// The transcript keeps every message; the pane needs only each worker's latest few.
const FEED_LIMIT = 200
const RECENT = 3
const RECENT_MORE = 10
const SEEN_LIMIT = 500
const BRIDGE_ATTEMPTS = 20
const SUBMIT_ATTEMPTS = 10
const TICK_MS = 60_000

const workers = atom({ plugin: 'pi-crew', key: 'workers' } as const, [] as CrewWorker[], { shape: 'workers-1' })
const feed = atom({ plugin: 'pi-crew', key: 'feed' } as const, [] as CrewMsg[], { shape: 'feed-1' })
const START: CrewView = { tab: 'inbox', filter: 'all', showAll: false, questionExpanded: false, collapsed: [] }
const view = atom({ plugin: 'pi-crew', key: 'view' } as const, START, { shape: 'view-3' })
const tick = atom({ plugin: 'pi-crew', key: 'tick' } as const, 0, { shape: 'tick-1' })
const seen = atom({ plugin: 'pi-crew', key: 'seen' } as const, [] as string[], { shape: 'seen-1' })

type BridgeEvent =
  | { type: 'ready'; lead: { name: string; id: string }; workers: CrewWorker[]; feed: CrewMsg[] }
  | { type: 'workers'; workers: CrewWorker[] }
  | { type: 'feed'; msg: CrewMsg }
  | { type: 'feedset'; feed: CrewMsg[] }
  | { type: 'roster' }
  | Inbound
  | { type: 'error'; error: string }

const TOOLS = [
  {
    name: 'spawn',
    description:
      'Start a Pi worker (pi-work) in a new agterm session after this one. It registers on pi-intercom with a fixed id, ' +
      'learns that this session leads it, and reports back with intercom send; each report starts a new turn here. ' +
      'Workers start a question with "Q:" and a finished task with "DONE:" carrying head, branch, tests, rc and logs, which the ' +
      'bridge checks against git. Give a first task to start it working at once. With a task, a cwd on the default branch is ' +
      'refused: give each worker its own worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker name: lowercase letters, digits, dashes; starts with a letter.' },
        cwd: { type: 'string', description: 'Absolute working directory for the worker.' },
        model: { type: 'string', description: 'Pi model/router profile. Default router/openai-work.' },
        task: { type: 'string', description: 'First task. Omit to start the worker idle.' },
        group: { type: 'string', description: 'Optional group shown in the crew pane, e.g. "backend". Lowercase, dashes.' },
        allowDefaultBranch: { type: 'boolean', description: 'Allow a task in a checkout on the default branch. Default false.' },
      },
      required: ['name', 'cwd'],
    },
  },
  {
    name: 'send',
    description:
      'Send a message to a worker (by worker name) or any intercom session: by full id, by its session name (any case), ' +
      'or by a unique id prefix of 6+ characters. An ambiguous or unknown name fails and lists the live sessions. ' +
      'Fails when the broker could not deliver it. To answer a question, pass its message id as replyTo.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        text: { type: 'string' },
        replyTo: { type: 'string', description: 'Message id being answered.' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'list',
    description:
      'List the crew (number, name, state, waitingOnLead, unread, time since the last message, live intercom status ' +
      'with the time since it last turned busy or idle, context %, open question) and the live intercom sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop',
    description: "Close a worker's agterm session; it stays listed as stopped. Stopping a stopped worker forgets it.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
] as const

const OPS: Record<string, (input: Record<string, unknown>) => Record<string, unknown>> = {
  spawn: input => ({
    op: 'spawn', name: input.name, cwd: input.cwd, model: input.model, task: input.task, group: input.group,
    allowDefaultBranch: input.allowDefaultBranch,
  }),
  send: input => ({ op: 'send', to: input.to, text: input.text, replyTo: input.replyTo }),
  list: () => ({ op: 'list' }),
  stop: input => ({ op: 'stop', name: input.name }),
}

// Module state; a reload re-runs register and session.start, which set it again.
let bridgeKey = ''
let bridgeBin = ''
let attempt = 0
// Worker reports become turns one at a time, in arrival order.
let submitting: Promise<void> = Promise.resolve()
// What the user wrote to a worker from the pane since its last report: the next turn tells the model.
const panelNotes = new Map<string, string[]>()

async function call($: Engine, request: Record<string, unknown>): Promise<{ ok: boolean; error?: string; raw: string }> {
  const ran = await $.process.run([bridgeBin, 'call', '--key', bridgeKey, JSON.stringify(request)])
  const raw = ran.stdout.trim() || JSON.stringify({ ok: false, error: ran.stderr.trim() || `exit ${ran.exitCode}` })
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; error?: string }
    return { ok: parsed.ok === true, error: parsed.error, raw }
  } catch {
    return { ok: false, error: raw, raw }
  }
}

/** One key per agterm pane: reloads, /clear and resume in that pane keep the same lead id and workers. */
async function resolveKey($: Engine): Promise<string> {
  const ran = await $.process.run(['sh', '-c', 'printf %s "${AGTERM_SESSION_ID:-}"'])
  const raw = ran.stdout.trim() || (await $.session.id())
  return raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64)
}

async function deliver($: Engine, ev: Inbound) {
  if ((await read($, seen)).includes(ev.id)) {
    await call($, { op: 'ack', id: ev.id })
    return
  }
  const name = ev.from.worker
  const worker = name ? (await read($, workers)).find(w => w.name === name) : undefined
  const peer = name ?? ev.from.name ?? ev.from.id
  const notes = name ? panelNotes.get(name) : undefined
  const body = turnText(worker, ev, notes)
  for (let n = 0; n < SUBMIT_ATTEMPTS; n++) {
    const result = await $.prompt.submit({ text: body })
    if (!result.drop) {
      if (name) panelNotes.delete(name)
      await update($, seen, ids => [...ids, ev.id].slice(-SEEN_LIMIT))
      await call($, { op: 'ack', id: ev.id })
      return
    }
    $.ui.log(`pi-crew: report ${ev.id} from ${peer} not submitted (${result.drop}); retrying`, { to: 'debug' })
    await $.clock.sleep(15_000)
  }
  // Left un-acked in the bridge inbox: the next bridge start replays it.
  $.ui.toast(`pi-crew: a report from ${peer} could not start a turn; run /reload-plugins to replay it`)
}

async function onEvent($: Engine, ev: BridgeEvent) {
  switch (ev.type) {
    case 'ready':
      attempt = 0
      await update($, workers, () => ev.workers)
      await update($, feed, () => ev.feed.slice(-FEED_LIMIT))
      $.ui.status(undefined)
      return
    case 'workers':
      await update($, workers, () => ev.workers)
      return
    case 'feed':
      await update($, feed, list => (list.some(m => m.id === ev.msg.id) ? list : [...list, ev.msg].slice(-FEED_LIMIT)))
      return
    case 'feedset':
      await update($, feed, () => ev.feed.slice(-FEED_LIMIT))
      return
    case 'error':
      $.ui.log(`pi-crew: ${ev.error}`, { to: 'debug' })
      return
    case 'message':
      submitting = submitting.then(() => deliver($, ev)).catch(error => $.ui.log(`pi-crew: deliver: ${String(error)}`, { to: 'debug' }))
      return
  }
}

const setView = ($: Engine, patch: Partial<CrewView>) => update($, view, v => ({ ...v, confirmStop: undefined, ...patch }))

async function openThread($: Engine, w: CrewWorker) {
  await setView($, { sel: w.name, showAll: false, questionExpanded: false })
  if (w.unread > 0 && bridgeKey) await call($, { op: 'read', name: w.name })
}

async function openPane($: Engine, patch: Partial<CrewView>, w?: CrewWorker) {
  await setView($, { sel: undefined, ...patch })
  if (w) await openThread($, w)
  await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
}

async function act($: Engine, request: Record<string, unknown>, what: string): Promise<boolean> {
  if (!bridgeKey) {
    $.ui.toast('pi-crew: the bridge is not running')
    return false
  }
  const answer = await call($, request)
  if (!answer.ok) $.ui.toast(`pi-crew: ${what} failed: ${answer.error ?? 'unknown'}`)
  return answer.ok
}

async function reply($: Engine, w: CrewWorker, text: string) {
  await setView($, {})
  const t = text.trim()
  if (!t) return
  if (await act($, { op: 'send', to: w.name, text: t, replyTo: w.ask?.id }, `send to ${tag(w)}`)) {
    panelNotes.set(w.name, [...(panelNotes.get(w.name) ?? []), t])
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive || bridgeKey) return started

    bridgeKey = await resolveKey($)
    bridgeBin = `${$.plugin.root}/bin/crew-bridge`

    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })
    await $.command.register({ name: 'crew', description: 'Open the Pi crew pane' })

    void (async () => {
      // Restart a bridge that exits (broker gone, crash); the module unloading ends the loop.
      for (; attempt < BRIDGE_ATTEMPTS; attempt++) {
        const bridge = $.process.spawn({ argv: [bridgeBin, 'serve', '--key', bridgeKey] })
        let pending = ''
        try {
          for await (const { stream, text } of bridge) {
            if (stream === 'stderr') {
              $.ui.log(text, { to: 'debug' })
              continue
            }
            pending += text
            let nl: number
            while ((nl = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, nl)
              pending = pending.slice(nl + 1)
              if (!line.trim()) continue
              try {
                await onEvent($, JSON.parse(line) as BridgeEvent)
              } catch (error) {
                $.ui.log(`pi-crew: bad bridge line: ${String(error)}`, { to: 'debug' })
              }
            }
          }
        } catch (error) {
          $.ui.log(`pi-crew: bridge failed: ${String(error)}`, { to: 'debug' })
        }
        $.ui.status('crew: bridge restarting')
        await $.clock.sleep(Math.min(30_000, 1_000 * 2 ** attempt))
      }
      $.ui.status('crew: bridge stopped (run /reload-plugins)')
    })()

    // Ages in the band and pane redraw once a minute while anyone works.
    void (async () => {
      for (;;) {
        await $.clock.sleep(TICK_MS)
        if ((await read($, workers)).some(w => w.state !== 'gone')) await update($, tick, t => t + 1)
      }
    })()

    return started
  })

  on('tool.call', async ($, e, next) => {
    const op = e.tool.startsWith(`mcp__${PLUGIN}__`) ? e.tool.slice(`mcp__${PLUGIN}__`.length) : undefined
    if (!op || !OPS[op]) return next(e)
    if (!bridgeKey) return { deny: 'pi-crew runs only in an interactive session' }
    const answer = await call($, OPS[op](e as unknown as Record<string, unknown>)).catch((error: unknown) => ({
      raw: JSON.stringify({ ok: false, error: String(error) }),
    }))
    return { result: answer.raw }
  })

  on('command.run', { command: 'crew' }, async $ => {
    await setView($, {})
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    return { text: 'Crew pane opened.' }
  })

  // The band: counts only, and the question waiting longest. Each part opens the pane where it points.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ws = await read($, workers)
    if (e.props.hasSurvey || ws.length === 0) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, tick)
    const t = tally(ws)
    const q = nextQuestion(ws)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns
    // Budgets use UTF-16 length, not terminal cells; wide CJK/emoji can still misfit.
    const crewHotkey = cols >= 3 ? 'c' : undefined
    const crewLabel = clip(`crew ${t.crew}`, Math.max(0, cols - (crewHotkey ? 3 : 0)))
    const crewWidth = crewLabel.length + (crewHotkey ? 3 : 0)
    const separator = cols >= crewWidth + 3 + 3 + (q ? String(q.n).length + 2 : 0) ? ' · ' : ' '
    const questionOverhead = q ? separator.length + 3 : 0
    const questionFloor = q ? `${t.ask > 1 ? `${GLYPH.ask}${t.ask} · ` : `${GLYPH.ask} `}${q.n}` : ''
    const questionFull = q ? bandQuestion(q, t.ask, now, Number.MAX_SAFE_INTEGER) : ''
    let remaining = Math.max(0, cols - crewWidth - questionOverhead)
    const chips = [
      { key: 'unread', count: t.unread, glyph: UNREAD, word: 'new', hotkey: 'u', tab: 'inbox' as const, filter: 'all' as const },
      { key: 'work', count: t.work, glyph: GLYPH.work, word: LABEL.work, tab: 'crew' as const, filter: 'work' as const },
      { key: 'idle', count: t.idle, glyph: GLYPH.idle, word: LABEL.idle, tab: 'crew' as const, filter: 'idle' as const },
      { key: 'gone', count: t.gone, glyph: GLYPH.gone, word: LABEL.gone, tab: 'crew' as const, filter: 'gone' as const },
    ].filter(c => c.count > 0)
    const visible = chips.flatMap(c => {
      // Protect question identity and unread first; secondary counts cannot shorten the question.
      const reserve = q ? c.key === 'unread' ? questionFloor.length : questionFull.length : 0
      const overhead = separator.length + (c.hotkey ? 3 : 0)
      const full = `${c.glyph} ${c.count} ${c.word}`
      const compact = `${c.glyph}${c.count}`
      const label = full.length + overhead + reserve <= remaining ? full : compact.length + overhead + reserve <= remaining ? compact : ''
      if (!label) return []
      remaining -= label.length + overhead
      return [{ ...c, label }]
    })
    const question = q ? bandQuestion(q, t.ask, now, remaining) : ''
    return (
      <Box flexDirection="row" flexWrap="nowrap">
        <Button plain hotkey={crewHotkey} key="crew" label={crewLabel} onPress={() => openPane($, { tab: 'crew', filter: 'all' })} />
        {q?.ask && question && <Text dimColor>{separator}</Text>}
        {q?.ask && question && <Button plain hotkey="a" key="next" label="answer oldest question" onPress={() => openPane($, { tab: 'inbox', filter: 'ask' }, q)}>
          <Text color={COLOR.ask}>{question}</Text>
        </Button>}
        {visible.map(c => <Box key={c.key} flexDirection="row">
          <Text dimColor>{separator}</Text>
          <Button plain hotkey={c.hotkey} key={c.key} label={c.label} onPress={() => openPane($, { tab: c.tab, filter: c.filter })}>
            <Text color={c.key === 'work' ? COLOR.work : c.key === 'unread' ? 'cyan' : undefined} dimColor={c.key === 'gone'}>{c.label}</Text>
          </Button>
        </Box>)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const ws = await read($, workers)
    const fd = await read($, feed)
    await read($, tick)
    const now = await $.clock.now()
    const cols = Math.max(1, e.props.bodyColumns)
    const narrow = e.props.placement === 'inline' || cols < 60
    const t = tally(ws)
    const tagWidth = Math.min(18, Math.floor(cols * 0.4), Math.max(5, ...ws.map(w => tag(w).length)))

    const glyph = (w: CrewWorker) => <Text color={COLOR[w.state]}>{GLYPH[w.state]}</Text>

    const close = async () => {
      await setView($, {})
      await $.ui.close({ id: PANE })
    }
    const dismiss = <Button plain hotkey="x" key="close" role="dismiss" label="×" onPress={close} />
    const closeHint = <Button plain dimColor hotkey="q" key="quit" label="close" onPress={close} />
    let firstRow = true
    const row = (w: CrewWorker, indent = '') => {
      const preview = oneLine(w.state === 'ask' && w.ask ? w.ask.text : (w.last?.text ?? LABEL[w.state]))
      indent = clip(indent, Math.max(0, cols - 2))
      const prefix = clip(`${indent}${GLYPH[w.state]} `, cols)
      const unread = w.unread ? clip(` ${UNREAD}${Math.min(w.unread, 99)}`, Math.max(0, cols - prefix.length)) : ''
      const nameWidth = Math.min(tagWidth, Math.max(0, cols - prefix.length - unread.length))
      const name = clip(tag(w), nameWidth).padEnd(nameWidth)
      let room = cols - prefix.length - name.length - unread.length
      const time = room >= 5 ? ` ${clip(age(w.lastAt, now), 4).padStart(4)}` : ''
      room -= time.length
      const excerpt = room >= 5 ? ` ${clip(preview, room - 1)}` : ''
      const autoFocus = firstRow ? true : undefined
      firstRow = false
      return (
        <Button plain autoFocus={autoFocus} key={`w-${w.name}`} label={`${tag(w)} ${LABEL[w.state]}`} onPress={() => openThread($, w)}>
          <Text color={COLOR[w.state]}>{prefix}</Text>{name}<Text dimColor>{time}</Text>
          <Text color="cyan">{unread}</Text>
          <Text dimColor={w.state !== 'ask'}>{excerpt}</Text>
        </Button>
      )
    }

    if (v.sel) {
      const w = ws.find(x => x.name === v.sel)
      if (!w) {
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between"><Button plain hotkey="b" key="back" label="back" onPress={() => setView($, { sel: undefined })} />{dismiss}</Box>
            {closeHint}
            <Text dimColor>{`No worker named ${v.sel}.`}</Text>
          </Box>
        )
      }
      const msgs = threadOf(fd, w.name)
      const { hidden, shown } = fold(msgs, v.showAll ? RECENT_MORE : RECENT)
      const bodyLines = v.showAll ? 8 : 3
      const question = w.ask ? clampText(w.ask.text, narrow ? 4 : 8, Math.max(1, cols - 4)) : undefined
      const confirming = v.confirmStop === w.name
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Button plain hotkey="b" key="back" label="back" onPress={() => setView($, { sel: undefined })} />
            {dismiss}
          </Box>
          <Box flexDirection="row" flexWrap="wrap">
            {w.agtermSession && <Button plain hotkey="o" key="open" label="worker terminal" onPress={async () => {
              await setView($, {})
              await act($, { op: 'focus', name: w.name }, `open ${tag(w)}`)
            }} />}
            <Text> </Text>
            <Button plain hotkey="s" key="stop" label={w.state === 'gone' ? 'forget' : 'stop'} onPress={() => setView($, { confirmStop: confirming ? undefined : w.name })} />
          </Box>
          {confirming && <Box flexDirection="row" flexWrap="wrap">
            <Text>{w.state === 'gone' ? `forget ${tag(w)}? removes its record  ` : `stop ${tag(w)}? its session closes and current work ends  `}</Text>
            <Button plain hotkey="c" key="confirm" label="confirm" onPress={async () => {
              await setView($, {})
              if (await act($, { op: 'stop', name: w.name }, `stop ${tag(w)}`)) await setView($, w.state === 'gone' ? { sel: undefined } : {})
            }} />
            <Text> </Text><Button plain hotkey="v" key="cancel" label="cancel" onPress={() => setView($, {})} />
          </Box>}
          <Text>{glyph(w)}<Text bold>{` ${clip(tag(w), narrow ? Math.max(8, cols - 4) : cols)}`}</Text></Text>
          <Text dimColor>{clip(`${w.group ? `${w.group} · ` : ''}${LABEL[w.state]} · ${age(w.startedAt, now)}`, cols)}</Text>
          <Text dimColor>{clip(`${w.cwd} · ${w.model} · last ${age(w.lastAt, now)}${w.unread ? ` · ${UNREAD} ${w.unread} new` : ''}`, cols)}</Text>
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
              {(hidden > 0 || v.showAll) && (
                <Button plain dimColor hotkey="e" key="more" label={v.showAll ? 'less' : 'more'} onPress={() => setView($, { showAll: !v.showAll })} />
              )}
            </Box>}
            {shown.map(m => {
              const mine = m.kind === 'out'
              const body = clampText(m.text, bodyLines, cols - 2)
              return (
                <Box key={m.id} flexDirection="column" marginBottom={1}>
                  <Text>
                    {mine ? <Text color="blue">you</Text> : <Text color={m.kind === 'ask' ? COLOR.ask : m.kind === 'done' ? COLOR.idle : COLOR.work}>{`${m.kind === 'ask' ? GLYPH.ask : m.kind === 'done' ? GLYPH.idle : GLYPH.work} ${w.name}`}</Text>}
                    <Text dimColor>{`  ${age(m.at, now)}${m.kind === 'done' ? ' · done' : ''}`}</Text>
                  </Text>
                  <Text dimColor={mine}>{`  ${body.text.replace(/\n/g, '\n  ')}${body.more ? ' …' : ''}`}</Text>
                </Box>
              )
            })}
          </Box>
          {w.state !== 'gone' && (
            <Input key={`reply-${w.name}`} placeholder={`message ${tag(w)} · Enter sends`} submitLabel="send" rows={2} onInput={async () => { if (v.confirmStop) await setView($, {}) }} onSubmit={value => reply($, w, value)} />
          )}
          <Box flexDirection="row" flexWrap="wrap"><Text dimColor>{`b back${hidden > 0 || v.showAll ? ' · e more' : ''}${w.agtermSession ? ' · o terminal' : ''}${w.ask ? `${question?.more ? ` · d ${v.questionExpanded ? 'collapse' : 'full'} question` : ''} · y/n send` : ''} · s ${w.state === 'gone' ? 'forget' : 'stop'} · Tab move · Enter activate · Esc/`}</Text>{closeHint}</Box>
        </Box>
      )
    }

    const tabs: Array<[CrewTab, string, string]> = [
      ['inbox', '1', `Inbox${t.unread ? ` ${UNREAD}${t.unread}` : ''}${t.ask ? ` ${GLYPH.ask}${t.ask}` : ''}`],
      ['crew', '2', `Crew ${t.crew}`],
    ]
    const filters: Array<[CrewFilter, string, string]> = [
      ['all', 'a', `all ${ws.length}`],
      ['ask', 'n', `${GLYPH.ask} needs you ${t.ask}`],
      ['work', 'w', `${GLYPH.work} working ${t.work}`],
      ['idle', 'i', `${GLYPH.idle} idle ${t.idle}`],
      ['gone', 's', `${GLYPH.gone} stopped ${t.gone}`],
    ]
    const shown = ws.filter(w => matches(w, v.filter))

    const body = () => {
      if (ws.length === 0) {
        return (
          <Box flexDirection="column">
            <Text dimColor>No workers yet.</Text>
            <Text dimColor>Ask Claude: "spawn a pi worker named api in ~/project to …"</Text>
          </Box>
        )
      }
      if (v.tab === 'crew') {
        return (
          <Box flexDirection="column">
            {groups(shown).map(g => {
              const folded = v.collapsed.includes(g.name)
              const gt = tally(g.workers)
              return (
                <Box key={`g-${g.name}`} flexDirection="column">
                  <Button
                    plain
                    key={`g-${g.name}`}
                    label={g.name}
                    onPress={() => update($, view, x => ({ ...x, collapsed: folded ? x.collapsed.filter(c => c !== g.name) : [...x.collapsed, g.name] }))}
                  >
                    <Text bold>{`${folded ? '▸' : '▾'} ${g.name}`}</Text>
                    <Text dimColor>{`  ${g.workers.length}${gt.ask ? ` · ${GLYPH.ask}${gt.ask}` : ''}${gt.work ? ` · ${GLYPH.work}${gt.work}` : ''}${gt.unread ? ` · ${UNREAD}${gt.unread}` : ''}`}</Text>
                  </Button>
                  {!folded && g.workers.map(w => row(w, '  '))}
                </Box>
              )
            })}
            {shown.length === 0 && <Text dimColor>No workers match this filter.</Text>}
          </Box>
        )
      }
      const order = inboxOrder(shown)
      return (
        <Box flexDirection="column">
          {order.map(w => row(w))}
          {order.length === 0 && <Text dimColor>No workers match this filter.</Text>}
        </Box>
      )
    }

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
        </Box>{dismiss}</Box>
        <Box flexDirection="row" flexWrap="wrap" marginBottom={1}>
          {filters.map(([id, key, label]) => (
            <Box key={`f-${id}`} marginRight={1}>
              <Button plain hotkey={key} key={`f-${id}`} label={label} onPress={() => setView($, { filter: id })}>
                <Text inverse={v.filter === id} dimColor={v.filter !== id}>{` ${label} `}</Text>
              </Button>
            </Box>
          ))}
        </Box>
        {body()}
        <Box flexDirection="row" flexWrap="wrap"><Text dimColor>1/2 tabs · a n w i s filter · Tab move · Enter activate · Esc/</Text>{closeHint}</Box>
      </Box>
    )
  })
}
