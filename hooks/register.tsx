import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { CrewLead, CrewMember, CrewMessage } from '../types'

const PLUGIN = 'pi-crew'
const PANE = 'pi-crew'
const LOG_LIMIT = 200
const SEEN_LIMIT = 500
const BRIDGE_ATTEMPTS = 20
const SUBMIT_ATTEMPTS = 10

const lead = atom({ plugin: 'pi-crew', key: 'lead' } as const, null as CrewLead, { shape: 'lead-1' })
const roster = atom({ plugin: 'pi-crew', key: 'roster' } as const, [] as CrewMember[], { shape: 'roster-1' })
const log = atom({ plugin: 'pi-crew', key: 'log' } as const, [] as CrewMessage[], { shape: 'log-1' })
const seen = atom({ plugin: 'pi-crew', key: 'seen' } as const, [] as string[], { shape: 'seen-1' })

type Inbound = {
  type: 'message'
  from: { id: string; name?: string; cwd: string; worker?: string }
  id: string
  replyTo?: string
  expectsReply: boolean
  text: string
}

type BridgeEvent =
  | { type: 'ready'; lead: { name: string; id: string } }
  | { type: 'roster'; sessions: CrewMember[] }
  | Inbound
  | { type: 'error'; error: string }

const TOOLS = [
  {
    name: 'spawn',
    description:
      'Start a Pi worker (pi-work) in a new agterm session after this one. It registers on pi-intercom with a fixed id, ' +
      'learns that this session leads it, and reports back with intercom send; each report starts a new turn here. ' +
      'Give a first task to start it working at once.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worker name: lowercase letters, digits, dashes; starts with a letter.' },
        cwd: { type: 'string', description: 'Absolute working directory for the worker.' },
        model: { type: 'string', description: 'Pi model/router profile. Default router/openai-work.' },
        task: { type: 'string', description: 'First task. Omit to start the worker idle.' },
      },
      required: ['name', 'cwd'],
    },
  },
  {
    name: 'send',
    description:
      'Send a message to a worker (by worker name) or any intercom session (by full session id). ' +
      'Fails when the broker could not deliver it. To answer a message that expects a reply, pass its message id as replyTo.',
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
    description: 'List live intercom sessions and the workers this session spawned (with their agterm session ids).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop',
    description: "Close a worker's agterm session and forget it.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
] as const

const OPS: Record<string, (input: Record<string, unknown>) => Record<string, unknown>> = {
  spawn: input => ({ op: 'spawn', name: input.name, cwd: input.cwd, model: input.model, task: input.task }),
  send: input => ({ op: 'send', to: input.to, text: input.text, replyTo: input.replyTo }),
  list: () => ({ op: 'list' }),
  stop: input => ({ op: 'stop', name: input.name }),
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Module state; a reload re-runs register and session.start, which set it again.
let bridgeKey = ''
let bridgeBin = ''
let attempt = 0
// Worker reports become turns one at a time, in arrival order.
let submitting: Promise<void> = Promise.resolve()

async function call($: Engine, request: Record<string, unknown>): Promise<string> {
  const ran = await $.process.run([bridgeBin, 'call', '--key', bridgeKey, JSON.stringify(request)])
  return ran.stdout.trim() || JSON.stringify({ ok: false, error: ran.stderr.trim() || `exit ${ran.exitCode}` })
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
  const who = ev.from.worker ?? ev.from.name ?? ev.from.id
  const head = [
    `Message from crew ${ev.from.worker ? `worker "${ev.from.worker}"` : `session "${who}" (not a crew worker)`}`,
    `id ${ev.from.id}, cwd ${ev.from.cwd}, message ${ev.id}`,
    ev.replyTo ? `in reply to ${ev.replyTo}` : '',
    ev.expectsReply ? `It expects a reply: answer with mcp__pi-crew__send replyTo="${ev.id}".` : '',
  ].filter(Boolean)
  for (let n = 0; n < SUBMIT_ATTEMPTS; n++) {
    const result = await $.prompt.submit({ text: `${head.join('; ')}\n\n${ev.text}` })
    if (!result.drop) {
      await update($, seen, ids => [...ids, ev.id].slice(-SEEN_LIMIT))
      await update($, log, list => [...list, { at: Date.now(), direction: 'in' as const, peer: who, text: ev.text }].slice(-LOG_LIMIT))
      await call($, { op: 'ack', id: ev.id })
      return
    }
    $.ui.log(`pi-crew: report ${ev.id} from ${who} not submitted (${result.drop}); retrying`, { to: 'debug' })
    await $.clock.sleep(15_000)
  }
  // Left un-acked in the bridge inbox: the next bridge start replays it.
  $.ui.toast(`pi-crew: a report from ${who} could not start a turn; run /reload-plugins to replay it`)
}

async function onEvent($: Engine, ev: BridgeEvent) {
  switch (ev.type) {
    case 'ready':
      attempt = 0
      await update($, lead, () => ev.lead)
      $.ui.status(`crew: ${ev.lead.name}`)
      return
    case 'roster': {
      await update($, roster, () => ev.sessions)
      const workers = ev.sessions.filter(s => s.worker)
      $.ui.status(`crew: ${workers.length} worker${workers.length === 1 ? '' : 's'} live`)
      return
    }
    case 'error':
      $.ui.log(`pi-crew: ${ev.error}`, { to: 'debug' })
      return
    case 'message':
      submitting = submitting.then(() => deliver($, ev)).catch(error => $.ui.log(`pi-crew: deliver: ${String(error)}`, { to: 'debug' }))
      return
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive || bridgeKey) return started

    bridgeKey = await resolveKey($)
    bridgeBin = `${$.plugin.root}/bin/crew-bridge`

    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })
    await $.command.register({ name: 'crew', description: 'Show the Pi crew pane' })

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

    return started
  })

  on('tool.call', async ($, e, next) => {
    const op = e.tool.startsWith(`mcp__${PLUGIN}__`) ? e.tool.slice(`mcp__${PLUGIN}__`.length) : undefined
    if (!op || !OPS[op]) return next(e)
    if (!bridgeKey) return { deny: 'pi-crew runs only in an interactive session' }
    const request = OPS[op](e as unknown as Record<string, unknown>)
    const answer = await call($, request).catch((error: unknown) => JSON.stringify({ ok: false, error: String(error) }))
    if (op === 'send' && answer.startsWith('{"ok":true')) {
      await update($, log, list =>
        [...list, { at: Date.now(), direction: 'out' as const, peer: String(request.to), text: String(request.text) }].slice(-LOG_LIMIT),
      )
    }
    return { result: answer }
  })

  on('command.run', { command: 'crew' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Pi crew' })
    return { text: 'Crew pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const me = await read($, lead)
    const members = await read($, roster)
    const messages = await read($, log)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 4)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - members.length - 6)

    return (
      <Box flexDirection="column">
        <Text bold>{me ? `lead ${me.name}` : 'bridge starting…'}</Text>
        {members.length === 0 && <Text dimColor>No other intercom sessions.</Text>}
        {members.map(m => (
          <Text dimColor={!m.worker}>
            {clip(`${m.worker ? '●' : '·'} ${m.worker ?? m.name ?? m.id.slice(0, 8)}  ${m.status ?? ''}  ${m.cwd}`, width)}
          </Text>
        ))}
        <Text dimColor>────</Text>
        {messages.length === 0 && <Text dimColor>No messages yet.</Text>}
        {messages.slice(-room).map(m => (
          <Text color={m.direction === 'in' ? 'cyan' : undefined}>
            {clip(`${m.direction === 'in' ? '←' : '→'} ${m.peer}: ${m.text.replace(/\s+/g, ' ')}`, width)}
          </Text>
        ))}
      </Box>
    )
  })
}
