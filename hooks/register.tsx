import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { CrewFilter, CrewLead, CrewMsg, CrewTab, CrewView, CrewWorker } from '../types'
import {
  COLOR, GLYPH, LABEL, UNREAD, age, checksLine, clampText, clip, fold, groups, inboxOrder, matches, nextQuestion, oneLine, tag,
  tally, threadOf, turnHead,
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

const lead = atom({ plugin: 'pi-crew', key: 'lead' } as const, null as CrewLead, { shape: 'lead-1' })
const workers = atom({ plugin: 'pi-crew', key: 'workers' } as const, [] as CrewWorker[], { shape: 'workers-1' })
const feed = atom({ plugin: 'pi-crew', key: 'feed' } as const, [] as CrewMsg[], { shape: 'feed-1' })
const START: CrewView = { tab: 'inbox', filter: 'all', showAll: false, collapsed: [] }
const view = atom({ plugin: 'pi-crew', key: 'view' } as const, START, { shape: 'view-2' })
const tick = atom({ plugin: 'pi-crew', key: 'tick' } as const, 0, { shape: 'tick-1' })
const seen = atom({ plugin: 'pi-crew', key: 'seen' } as const, [] as string[], { shape: 'seen-1' })

type Inbound = {
  type: 'message'
  from: { id: string; name?: string; cwd: string; worker?: string }
  id: string
  replyTo?: string
  expectsReply: boolean
  kind: CrewMsg['kind'] | 'idle'
  text: string
  checks?: { ok: boolean; notes: string[] }
}

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
      'and how long it has held, context %, open question) and the live intercom sessions.',
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
  const head = [
    turnHead(worker, ev.kind, peer),
    `intercom id ${ev.from.id}, cwd ${ev.from.cwd}, message ${ev.id}`,
    ev.replyTo ? `in reply to ${ev.replyTo}` : '',
    ev.kind === 'ask' ? `Answer with mcp__pi-crew__send to "${peer}" replyTo "${ev.id}".` : '',
    ev.kind === 'idle' ? `Check it: its screen below, mcp__pi-crew__send to nudge "${peer}", or mcp__pi-crew__stop.` : '',
  ].filter(Boolean)
  const checks = checksLine(ev.checks)
  const body = [
    head.join('; '),
    ...(checks ? [checks] : []),
    ...(notes?.length ? [`Since its last report the user wrote to ${peer} from the crew pane: ${notes.map(n => `"${n}"`).join(', ')}`] : []),
    '',
    ev.text,
  ].join('\n')
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
      await update($, lead, () => ev.lead)
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
  await setView($, { sel: w.name, showAll: false })
  if (w.unread > 0 && bridgeKey) await call($, { op: 'read', name: w.name })
}

async function openPane($: Engine, patch: Partial<CrewView>, w?: CrewWorker) {
  await setView($, { sel: undefined, ...patch })
  if (w) await openThread($, w)
  await $.ui.open({ id: PANE, title: TITLE, focus: true })
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
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
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
    const sep = <Text dimColor> · </Text>
    const head = `crew ${t.crew}${t.ask ? ` · ◆ ${t.ask} needs you` : ''} · ● ${t.work} · ○ ${t.idle}${t.gone ? ` · ✕ ${t.gone}` : ''}${t.unread ? ` · ${UNREAD} ${t.unread} new` : ''} · ? `
    const room = Math.max(8, e.props.bodyColumns - head.length)
    return (
      <Box flexDirection="row">
        <Button plain key="crew" onPress={() => openPane($, { tab: 'crew', filter: 'all' })}>
          <Text bold>crew</Text> {String(t.crew)}
        </Button>
        {t.ask > 0 && sep}
        {t.ask > 0 && (
          <Button plain key="ask" onPress={() => openPane($, { tab: 'inbox', filter: 'ask' }, q)}>
            <Text color={COLOR.ask}>{`${GLYPH.ask} ${t.ask} needs you`}</Text>
          </Button>
        )}
        {sep}
        <Button plain key="work" onPress={() => openPane($, { tab: 'crew', filter: 'work' })}>
          <Text color={COLOR.work}>{`${GLYPH.work} ${t.work}`}</Text>
        </Button>
        {sep}
        <Button plain key="idle" onPress={() => openPane($, { tab: 'crew', filter: 'idle' })}>{`${GLYPH.idle} ${t.idle}`}</Button>
        {t.gone > 0 && sep}
        {t.gone > 0 && (
          <Button plain dimColor key="gone" onPress={() => openPane($, { tab: 'crew', filter: 'gone' })}>{`${GLYPH.gone} ${t.gone}`}</Button>
        )}
        {t.unread > 0 && sep}
        {t.unread > 0 && (
          <Button plain key="unread" onPress={() => openPane($, { tab: 'inbox', filter: 'all' })}>
            <Text color="cyan">{`${UNREAD} ${t.unread} new`}</Text>
          </Button>
        )}
        {q?.ask && sep}
        {q?.ask && (
          <Button plain dimColor key="next" onPress={() => openPane($, { tab: 'inbox', filter: 'ask' }, q)}>
            {clip(`? ${tag(q)}: ${oneLine(q.ask.text)}`, room)}
          </Button>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const ws = await read($, workers)
    const fd = await read($, feed)
    const me = await read($, lead)
    await read($, tick)
    const now = await $.clock.now()
    const cols = Math.max(24, e.props.bodyColumns)
    const narrow = e.props.placement === 'inline' || cols < 60
    const t = tally(ws)
    const tagWidth = Math.min(18, Math.max(5, ...ws.map(w => tag(w).length)))

    const glyph = (w: CrewWorker) => <Text color={COLOR[w.state]}>{GLYPH[w.state]}</Text>

    const row = (w: CrewWorker, indent = '') => {
      const preview = oneLine(w.state === 'ask' && w.ask ? w.ask.text : (w.last?.text ?? LABEL[w.state]))
      const fixed = indent.length + 2 + tagWidth + 1 + 4 + (w.unread ? 4 : 0) + 1
      return (
        <Button plain key={`w-${w.name}`} label={`${tag(w)} ${LABEL[w.state]}`} onPress={() => openThread($, w)}>
          {indent}
          {glyph(w)} {tag(w).padEnd(tagWidth)} <Text dimColor>{age(w.lastAt, now).padStart(4)}</Text>
          {w.unread ? <Text color="cyan">{` ${UNREAD}${Math.min(w.unread, 99)}`}</Text> : ''}{' '}
          <Text dimColor={w.state !== 'ask'}>{clip(preview, cols - fixed)}</Text>
        </Button>
      )
    }

    if (v.sel) {
      const w = ws.find(x => x.name === v.sel)
      if (!w) {
        return (
          <Box flexDirection="column">
            <Button plain hotkey="b" key="back" label="back" onPress={() => setView($, { sel: undefined })} />
            <Text dimColor>{`No worker named ${v.sel}.`}</Text>
          </Box>
        )
      }
      const msgs = threadOf(fd, w.name)
      const { hidden, shown } = fold(msgs, v.showAll ? RECENT_MORE : RECENT)
      const bodyLines = v.showAll ? 8 : 3
      const confirming = v.confirmStop === w.name
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexDirection="row">
              <Button plain hotkey="b" key="back" label="back" onPress={() => setView($, { sel: undefined })} />
              <Text> </Text>
              {glyph(w)}
              <Text bold>{` ${tag(w)}`}</Text>
              <Text dimColor>{`${w.group ? ` · ${w.group}` : ''} · ${LABEL[w.state]} · ${age(w.startedAt, now)}`}</Text>
            </Box>
            <Box flexDirection="row">
              {w.agtermSession && (
                <Button plain hotkey="o" key="open" label="open pane" onPress={() => act($, { op: 'focus', name: w.name }, `open ${tag(w)}`)} />
              )}
              <Text> </Text>
              <Button
                plain
                hotkey="s"
                key="stop"
                label={confirming ? (w.state === 'gone' ? 'forget? press s' : 'stop? press s') : w.state === 'gone' ? 'forget' : 'stop'}
                onPress={async () => {
                  if (!confirming) return update($, view, x => ({ ...x, confirmStop: w.name }))
                  const forgetting = w.state === 'gone'
                  if (await act($, { op: 'stop', name: w.name }, `stop ${tag(w)}`)) await setView($, forgetting ? { sel: undefined } : {})
                }}
              />
            </Box>
          </Box>
          <Text dimColor>{clip(`${w.cwd} · ${w.model} · last ${age(w.lastAt, now)}${w.unread ? ` · ${UNREAD} ${w.unread} new` : ''}`, cols)}</Text>
          {w.ask && (
            <Box flexDirection="column" borderStyle="round" borderColor={COLOR.ask} paddingX={1} marginTop={1}>
              <Text color={COLOR.ask} bold>{`${GLYPH.ask} question · ${age(w.ask.at, now)}`}</Text>
              <Text>{clampText(w.ask.text, narrow ? 4 : 8, cols - 4).text}</Text>
              <Box flexDirection="row">
                <Button plain hotkey="y" key="yes" label="yes" onPress={() => reply($, w, 'yes')} />
                <Text>  </Text>
                <Button plain hotkey="n" key="no" label="no" onPress={() => reply($, w, 'no')} />
                <Text dimColor>  or type an answer below</Text>
              </Box>
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            {msgs.length === 0 && <Text dimColor>No messages yet.</Text>}
            {msgs.length > 0 && <Box flexDirection="row">
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
                    {mine ? <Text color="blue">you</Text> : <Text color={m.kind === 'ask' ? COLOR.ask : COLOR.work}>{`${m.kind === 'ask' ? GLYPH.ask : m.kind === 'done' ? GLYPH.idle : GLYPH.work} ${w.name}`}</Text>}
                    <Text dimColor>{`  ${age(m.at, now)}${m.kind === 'done' ? ' · done' : ''}`}</Text>
                  </Text>
                  <Text dimColor={mine}>{`  ${body.text.replace(/\n/g, '\n  ')}${body.more ? ' …' : ''}`}</Text>
                </Box>
              )
            })}
          </Box>
          {w.state !== 'gone' && (
            <Input key={`reply-${w.name}`} placeholder={`message ${tag(w)}`} rows={2} onSubmit={value => reply($, w, value)} />
          )}
        </Box>
      )
    }

    const tabs: Array<[CrewTab, string, string]> = [
      ['inbox', '1', `Inbox${t.unread ? ` ${UNREAD}${t.unread}` : ''}${t.ask ? ` ${GLYPH.ask}${t.ask}` : ''}`],
      ['crew', '2', `Crew ${t.crew}`],
    ]
    const filters: Array<[CrewFilter, string, string]> = [
      ['all', 'a', 'all'],
      ['ask', 'q', `${GLYPH.ask} ${t.ask}`],
      ['work', 'w', `${GLYPH.work} ${t.work}`],
      ['idle', 'i', `${GLYPH.idle} ${t.idle}`],
      ['gone', 'x', `${GLYPH.gone} ${t.gone}`],
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
        <Box flexDirection="row" flexWrap="wrap">
          {tabs.map(([id, key, label]) => (
            <Box key={`tab-${id}`} marginRight={2}>
              <Button plain hotkey={key} key={`tab-${id}`} label={label} onPress={() => setView($, { tab: id })}>
                <Text bold={v.tab === id} underline={v.tab === id} dimColor={v.tab !== id}>{label}</Text>
              </Button>
            </Box>
          ))}
        </Box>
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
        {!narrow && me && <Text dimColor>{clip(`lead ${me.name} · ${me.id}`, cols)}</Text>}
      </Box>
    )
  })
}
