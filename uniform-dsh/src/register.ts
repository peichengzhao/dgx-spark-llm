// The Uniform DGX Spark plugin, as a Claude Code mod for DeepSeek Harness.
//
// The same remote client as `../../uniform`: the session drives a Uniform
// platform that is already running, over its REST API and nothing else. What
// changes is the host. DeepSeek Harness runs the mod through the experimental
// Claude Code mods bridge, which serves `$.state`, `$.tool`, `$.command`,
// `$.clock` and `$.http`, but places no pane and sends `$.ui.status` to the
// host log. So the deployments are drawn in the band above the prompt, and
// `/uniform` answers with the listing as text.
//
// One host process serves every session, so nothing per-session lives in a
// module variable: the deployments are in `$.state`, the poll loop runs on
// `$.clock` timers (which the bridge closes with the session that started
// them), and the one map below is keyed by session id.

import type {
  ModOn,
  ModsApi,
  PluginOptions,
  StateRef,
  UiElements,
  UiNode,
} from '@deepseek-ai/dsh-experimental-claude-code-mods'

import {
  createDeployment,
  deploymentLogs,
  getDeployment,
  isTerminal,
  listDeployments,
  STATUS_LABELS,
  stopDeployment,
  systemMetrics,
  type PlatformConfig,
  type PlatformResult,
  type Transport,
} from '../../uniform/hooks/client'
import type { Deployment } from '../../uniform/types'

export const PLUGIN = 'uniform'
const COMMAND = 'uniform'

/** How long to wait between re-reads while a deployment is still on its way up or down. */
const POLL_MS = 3_000
/** And once every deployment is serving or has ended. */
const IDLE_POLL_MS = 30_000
/** The log tail a call gets when it named none, and the most one may ask for. */
const LOG_TAIL = 200
const LOG_TAIL_MAX = 2_000
/** The platform on this machine, so a local session needs no setup. */
export const DEFAULT_URL = 'http://127.0.0.1:18180'
/** The progress bar's width in the band, when the band is wide enough for one. */
const BAR_CELLS = 10

/** Whether the configured platform answered the last read, and how it refused when it did not. */
type Reach = { url: string; isReachable: boolean; isTokenRefused: boolean }

type Slot<T> = { ref: StateRef; initial: T }

const platform: Slot<Reach> = {
  ref: { plugin: PLUGIN, key: 'platform' },
  initial: { url: '', isReachable: false, isTokenRefused: false },
}
const deployments: Slot<Deployment[]> = { ref: { plugin: PLUGIN, key: 'deployments' }, initial: [] }
/** The deployment this session started or stopped last; `null` until it acts on one. */
const watching: Slot<string | null> = { ref: { plugin: PLUGIN, key: 'watching' }, initial: null }

// Every session asks the same platform, so the options are the mod's, not a session's.
let config: PlatformConfig = { url: DEFAULT_URL, token: '' }

/**
 * The newest read each session started. A read that comes back after a newer
 * one started publishes nothing, so a slow answer cannot overwrite a fresher one.
 */
const latestRead = new Map<string, number>()
let reads = 0

export function register(on: ModOn, options: PluginOptions): void {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'List the Uniform platform deployments',
    })
    await registerTools($)
    await write($, platform, { url: config.url, isReachable: false, isTokenRefused: false })
    startWatching($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    latestRead.delete(await $.session.id())

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await poll($)

    const info = await read($, platform)
    if (!info.isReachable) {
      return { text: `Uniform: ${unreachableText(info)}. Set platform_url and api_token in the profile's cordis.patch.yml.` }
    }

    const list = await read($, deployments)
    if (list.length === 0) return { text: `Uniform (${config.url}): no deployments yet.` }

    const tracked = await read($, watching)
    const lines = list.map(one => `${one.id === tracked ? '*' : ' '} ${listLine(one)}`)

    return { text: [`Uniform (${config.url}): ${list.length} deployment(s), ${countMoving(list)} moving.`, ...lines].join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const info = await read($, platform)
    const list = await read($, deployments)
    const tracked = await read($, watching)

    const drawn = band($.ui.resolve(e), info, list, tracked, $, bandWidth(e.props))
    if (drawn === null) return next(e)

    return drawn
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_list` }, async $ => listTool($))
  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_deploy` }, async ($, e) => deployTool($, e))
  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_status` }, async ($, e) => statusTool($, e))
  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_logs` }, async ($, e) => logsTool($, e))
  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_metrics` }, async $ => metricsTool($))
  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_stop` }, async ($, e) => stopTool($, e))
}

/** Reads the platform once and republishes what it answered, unless a newer read has started since. */
async function poll($: ModsApi): Promise<void> {
  const session = await $.session.id()
  const mine = ++reads
  latestRead.set(session, mine)

  const answered = await listDeployments(send($), config)
  if (latestRead.get(session) !== mine) return

  if (!answered.isOk) {
    const refused = answered.status === 401 || answered.status === 403
    await write($, platform, { url: config.url, isReachable: false, isTokenRefused: refused })
    return
  }

  await write($, platform, { url: config.url, isReachable: true, isTokenRefused: false })
  await write($, deployments, answered.value)
}

/**
 * Keeps re-reading the platform until the session ends: quickly while a
 * deployment is on its way up or down, slowly once all of them are serving or
 * have ended. Each period is asked for only after the previous read came back,
 * so a slow platform slows the poll instead of stacking calls behind it.
 */
function startWatching($: ModsApi): void {
  const beat = async (): Promise<void> => {
    try {
      await poll($)
    } finally {
      const list = await read($, deployments).catch(() => [] as Deployment[])
      schedule($, list.some(isMoving) ? POLL_MS : IDLE_POLL_MS, beat)
    }
  }

  schedule($, POLL_MS, beat)
}

/** A timer the bridge may refuse once the session that owns it has ended; then the loop just stops. */
function schedule($: ModsApi, ms: number, fn: () => Promise<void>): void {
  try {
    $.clock.after(ms, fn)
  } catch {
    // The session is closing.
  }
}

/** The tools the model can call. Each answers from the platform, not `$.state`. */
async function registerTools($: ModsApi): Promise<void> {
  await $.tool.register({
    name: 'uniform_list',
    description:
      'List the model deployments the Uniform platform knows about, with each ' +
      "one's id, model, stage and progress.",
    inputSchema: { type: 'object', properties: {} },
  })

  await $.tool.register({
    name: 'uniform_deploy',
    description:
      'Deploy a model through the Uniform platform. Answers as soon as the ' +
      'platform queues it, which is well before the server is serving: follow it ' +
      'with uniform_status or uniform_logs. Only model_id is required; every ' +
      "other parameter keeps the platform's own default.",
    inputSchema: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description:
            'The model to deploy, such as "Qwen/Qwen3-8B": a Hugging Face or ' +
            'ModelScope repository id, or any id the platform can resolve.',
        },
        source: {
          type: 'string',
          enum: ['huggingface', 'modelscope'],
          description: 'Where to fetch the weights from; defaults to huggingface.',
        },
        local_model_path: {
          type: 'string',
          description:
            'An absolute path to weights already on the machine, to deploy those ' +
            'instead of downloading them.',
        },
        port: { type: 'integer', description: 'Host port for the API; default 8000.' },
        image: { type: 'string', description: 'The inference container image to run.' },
        max_model_len: {
          type: 'integer',
          description: 'The longest context the server will accept, in tokens.',
        },
        gpu_memory_utilization: {
          type: 'number',
          description: 'The fraction of GPU memory the server may claim; default 0.9.',
        },
        trust_remote_code: {
          type: 'boolean',
          description:
            'Allow the model repository to run its own Python on this machine. ' +
            'Only for a repository the person trusts.',
        },
      },
      required: ['model_id'],
    },
  })

  await $.tool.register({
    name: 'uniform_status',
    description:
      'Report one deployment in detail: model, stage, progress, attempts and any ' +
      'error. Defaults to the deployment this session is watching, else the most ' +
      'recent one.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Defaults to the current one.' },
      },
    },
  })

  await $.tool.register({
    name: 'uniform_logs',
    description:
      'Read the container log the platform kept for a deployment — where a ' +
      'download, a container start or a model load reports why it stalled or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Defaults to the current one.' },
        tail: {
          type: 'integer',
          description: `Lines to read; default ${LOG_TAIL}, at most ${LOG_TAIL_MAX}.`,
        },
      },
    },
  })

  await $.tool.register({
    name: 'uniform_metrics',
    description:
      "The machine's CPU, GPU, unified memory, disk and network, as the platform " +
      'samples them.',
    inputSchema: { type: 'object', properties: {} },
  })

  await $.tool.register({
    name: 'uniform_stop',
    description:
      'Stop a deployment through the platform. Confirm with the person first ' +
      'unless they asked for this stop.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Defaults to the current one.' },
      },
    },
  })
}

async function listTool($: ModsApi) {
  const answered = await listDeployments(send($), config)
  if (!answered.isOk) return failed(answered.reason)
  if (answered.value.length === 0) return ok('No deployments.')

  return ok(answered.value.map(listLine).join('\n'))
}

async function deployTool($: ModsApi, input: Record<string, unknown>) {
  const modelId = input.model_id
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    return failed('model_id is required, such as "Qwen/Qwen3-8B".')
  }

  const answered = await createDeployment(send($), config, deployPayload(input, modelId))
  if (!answered.isOk) return failed(answered.reason)

  await write($, watching, answered.value.id)
  await poll($)

  return ok(
    `Queued ${nameOf(answered.value)} as deployment ${answered.value.id}. Follow it ` +
      'with uniform_status or uniform_logs; the band above the prompt tracks it.',
  )
}

async function statusTool($: ModsApi, input: Record<string, unknown>) {
  const target = await resolveTarget($, input.deployment_id)
  if (!target.isOk) return failed(target.reason)

  const answered = await getDeployment(send($), config, target.value)
  if (!answered.isOk) return failed(answered.reason)

  return ok(describeDeployment(answered.value))
}

async function logsTool($: ModsApi, input: Record<string, unknown>) {
  const target = await resolveTarget($, input.deployment_id)
  if (!target.isOk) return failed(target.reason)

  const asked = typeof input.tail === 'number' ? Math.trunc(input.tail) : LOG_TAIL
  const tail = Math.min(Math.max(asked, 1), LOG_TAIL_MAX)

  const answered = await deploymentLogs(send($), config, target.value, tail)
  if (!answered.isOk) return failed(answered.reason)
  if (answered.value.trim() === '') return ok(`No log lines for ${target.value} yet.`)

  return ok(answered.value)
}

async function metricsTool($: ModsApi) {
  const answered = await systemMetrics(send($), config)
  if (!answered.isOk) return failed(answered.reason)

  return ok(JSON.stringify(answered.value, null, 2))
}

async function stopTool($: ModsApi, input: Record<string, unknown>) {
  const target = await resolveTarget($, input.deployment_id)
  if (!target.isOk) return failed(target.reason)

  const answered = await stopDeployment(send($), config, target.value)
  if (!answered.isOk) return failed(answered.reason)

  await write($, watching, answered.value.id)
  await poll($)

  return ok(`${nameOf(answered.value)} (${answered.value.id}) is ${labelOf(answered.value)}.`)
}

/**
 * The deployment a call means when it named none: the one this session is
 * watching, else the newest the platform holds.
 */
async function resolveTarget($: ModsApi, named: unknown): Promise<PlatformResult<string>> {
  if (typeof named === 'string' && named.trim() !== '') {
    return { isOk: true, value: named.trim() }
  }

  const tracked = await read($, watching)
  if (tracked !== null) return { isOk: true, value: tracked }

  const known = (await read($, deployments))[0]
  if (known !== undefined) return { isOk: true, value: known.id }

  const answered = await listDeployments(send($), config)
  if (answered.isOk) {
    const newest = answered.value[0]
    if (newest !== undefined) return { isOk: true, value: newest.id }
  }

  return { isOk: false, status: null, reason: 'no deployment to act on; pass deployment_id.' }
}

/**
 * The band above the prompt: the deployments on their way up or down and the
 * ones serving, and the session's own deployment once it failed, until that
 * is dismissed. `null` when there is nothing this session would want to see,
 * so the band goes to the next mod.
 */
function band(
  ui: UiElements,
  info: Reach,
  list: readonly Deployment[],
  tracked: string | null,
  $: ModsApi,
  columns: number,
): UiNode | null {
  const { Box, Text, Button } = ui

  // Only a session that has used the platform hears that it stopped answering.
  if (!info.isReachable) {
    if (tracked === null || info.url === '') return null

    return Box({
      flexDirection: 'row',
      paddingX: 1,
      children: [Text({ color: 'red', bold: true, children: PLUGIN }), Text({ children: `  ${unreachableText(info)}` })],
    })
  }

  const shown = [...list]
    .filter(one => !isTerminal(one.status) || (one.id === tracked && one.status === 'failed'))
    .sort((a, b) => Number(b.id === tracked) - Number(a.id === tracked))
  if (shown.length === 0) return null

  const rows = shown.map(one => {
    const parts: UiNode[] = [
      Text({ color: 'cyan', bold: true, children: `${PLUGIN}${one.id === tracked ? '*' : ''}` }),
      Text({ children: `  ${nameOf(one)}  ` }),
      Text({ color: colorOf(one), children: labelOf(one) }),
    ]

    if (isMoving(one)) {
      if (columns >= 80) parts.push(Text({ color: colorOf(one), children: `  ${bar(one.progress)}` }))
      parts.push(Text({ dimColor: true, children: ` ${percentOf(one)}%` }))
    }

    if (one.status === 'failed') {
      if (one.error_message !== null) parts.push(Text({ dimColor: true, children: `  ${one.error_message}` }))
      parts.push(
        Button({
          label: 'Dismiss',
          onPress: async () => {
            if ((await read($, watching)) === one.id) await write($, watching, null)
          },
        }),
      )
    }

    return Box({ flexDirection: 'row', children: parts })
  })

  return Box({ flexDirection: 'column', paddingX: 1, children: rows })
}

function bandWidth(props: Readonly<Record<string, unknown>>): number {
  return typeof props.bodyColumns === 'number' ? props.bodyColumns : 120
}

function bar(progress: number): string {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(progress * BAR_CELLS)))

  return '█'.repeat(filled) + '░'.repeat(BAR_CELLS - filled)
}

function colorOf(one: Deployment): string {
  if (one.status === 'running') return 'green'
  if (one.status === 'failed') return 'red'
  if (isTerminal(one.status)) return 'gray'

  return 'yellow'
}

/** The tool's answer: the text the model reads. */
function ok(text: string) {
  return { result: text }
}

/** A refusal, which the bridge renders to the model as `Error: <reason>`. */
function failed(reason: string) {
  return { deny: reason }
}

async function read<T>($: ModsApi, slot: Slot<T>): Promise<T> {
  const { value } = await $.state.get(slot.ref)

  return value === undefined ? slot.initial : (value as T)
}

/** Writes a slot only when its value changed, since every write redraws the band that read it. */
async function write<T>($: ModsApi, slot: Slot<T>, value: T): Promise<void> {
  const { value: held } = await $.state.get(slot.ref)
  if (held !== undefined && JSON.stringify(held) === JSON.stringify(value)) return

  await $.state.set(slot.ref, value)
}

/** The mod's options as the client wants them: two strings, always. */
function configFrom(options: PluginOptions): PlatformConfig {
  const url = typeof options.platform_url === 'string' ? options.platform_url.trim() : ''
  const token = typeof options.api_token === 'string' ? options.api_token.trim() : ''

  return { url: (url === '' ? DEFAULT_URL : url).replace(/\/+$/, ''), token }
}

/** The bridge's own fetch, handed to the client as a plain function. */
function send($: ModsApi): Transport {
  return (url, init) => $.http.fetch(url, init)
}

/**
 * The body `POST /api/v1/deployments` takes. Only the fields the call actually
 * passed are sent, so every other parameter keeps the platform's own default
 * rather than being pinned to a copy of it here.
 */
function deployPayload(input: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const parameters: Record<string, unknown> = {}
  const carry = [
    'source',
    'local_model_path',
    'port',
    'image',
    'max_model_len',
    'gpu_memory_utilization',
    'trust_remote_code',
  ] as const

  for (const field of carry) {
    if (input[field] !== undefined) parameters[field] = input[field]
  }
  // The platform records the acknowledgement beside the permission itself.
  if (parameters.trust_remote_code === true) parameters.remote_code_acknowledged = true

  return { model_id: modelId.trim(), parameters }
}

/** On its way up or down: still worth a fast poll. A serving deployment is settled. */
function isMoving(one: Deployment): boolean {
  return !isTerminal(one.status) && one.status !== 'running'
}

function countMoving(list: readonly Deployment[]): number {
  return list.filter(isMoving).length
}

function nameOf(one: Deployment): string {
  return one.display_name ?? one.model_id
}

function labelOf(one: Deployment): string {
  return STATUS_LABELS[one.status] ?? one.status
}

function percentOf(one: Deployment): number {
  return Math.round(one.progress * 100)
}

function listLine(one: Deployment): string {
  const progress = isMoving(one) ? ` ${percentOf(one)}%` : ''

  return `${one.id}  ${nameOf(one)}  ${labelOf(one)}${progress}`
}

function unreachableText(info: Reach): string {
  if (info.isTokenRefused) return `the API token was refused by ${info.url}`

  return `no platform at ${info.url}`
}

/** One deployment, as the model reads it in a status answer. */
function describeDeployment(one: Deployment): string {
  const lines = [
    `deployment: ${one.id}`,
    `model: ${nameOf(one)}`,
    `status: ${labelOf(one)} (${percentOf(one)}%)`,
  ]
  if (one.error_message !== null) lines.push(`error: ${one.error_message}`)
  lines.push(`attempt: ${one.attempt}`, `created: ${one.created_at}`)

  return lines.join('\n')
}
