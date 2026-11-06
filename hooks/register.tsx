import type { Register } from 'claude-code'

import type { CrewRequest } from '../types'
import { registerBand } from './band'
import { PLUGIN, call, connect, connected, setView, showPane, superviseBridge, tickLoop } from './crew'
import { registerPane } from './pane'

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

type ToolOp = 'spawn' | 'send' | 'list' | 'stop'
type ToolRequest<K extends ToolOp> = Extract<CrewRequest, { op: K }>
// The engine checks a tool call against its inputSchema, so each builder sees the fields of its own request.
const OPS: { [K in ToolOp]: (input: Omit<ToolRequest<K>, 'op'>) => ToolRequest<K> } = {
  spawn: input => ({
    op: 'spawn', name: input.name, cwd: input.cwd, model: input.model, task: input.task, group: input.group,
    allowDefaultBranch: input.allowDefaultBranch,
  }),
  send: input => ({ op: 'send', to: input.to, text: input.text, replyTo: input.replyTo }),
  list: () => ({ op: 'list' }),
  stop: input => ({ op: 'stop', name: input.name }),
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive || connected()) return started

    await connect($)

    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })
    await $.command.register({ name: 'crew', description: 'Open the Pi crew pane' })

    void superviseBridge($)
    void tickLoop($)

    return started
  })

  on('tool.call', async ($, e, next) => {
    const op = e.tool.startsWith(`mcp__${PLUGIN}__`) ? e.tool.slice(`mcp__${PLUGIN}__`.length) : undefined
    if (!op || !Object.hasOwn(OPS, op)) return next(e)
    if (!connected()) return { deny: 'pi-crew runs only in an interactive session' }
    // `op` names an entry of OPS and the engine has checked `e` against that tool's schema; TS cannot correlate the two.
    const build = OPS[op as ToolOp] as (input: unknown) => CrewRequest
    const answer = await call($, build(e)).catch((error: unknown) => ({
      raw: JSON.stringify({ ok: false, error: String(error) }),
    }))
    return { result: answer.raw }
  })

  on('command.run', { command: 'crew' }, async $ => {
    await setView($, {})
    await showPane($)
    return { text: 'Crew pane opened.' }
  })

  registerBand(on)
  registerPane(on)
}
