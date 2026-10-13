// The Uniform DGX Spark plugin.
//
// The session drives a Uniform platform that is already running somewhere: on
// this machine at http://127.0.0.1:18180 by default, or on a shared DGX Spark
// behind an SSH tunnel. This module is only the session's end of that: it
// registers tools over the platform's REST API, keeps the deployments it saw
// in `$.state`, and draws them.
//
// What it deliberately does NOT do is reach past the platform. There is no
// Docker here, no model cache, no container handle: the platform owns the
// rules about what a session may deploy and how, and this plugin asks it in
// the platform's own terms.
//
// Shape of this file: the engine reads the source before it loads the module
// and allows `$` only where it is spelled `$.noun.event(...)` — at a hook's
// call site, or inside a function declared at the top of this file. So the
// work lives in top-level functions that take `$`, and the hooks below are
// thin. Everything a function needs beyond `$` is a parameter.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

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
} from './client'
import type { Deployment } from '../types'

const PLUGIN = 'uniform'
const PANE_ID = 'uniform-deployments'
const COMMAND = 'uniform'

/** How long to wait between re-reads while something is still moving. */
const POLL_MS = 3_000
/** And once everything the session knows about has settled. */
const IDLE_POLL_MS = 30_000
/** The log tail a call gets when it named none, and the most one may ask for. */
const LOG_TAIL = 200
const LOG_TAIL_MAX = 2_000
/** The platform on this machine, so a local session needs no setup. */
const DEFAULT_URL = 'http://127.0.0.1:18180'

const platform = atom({ plugin: 'uniform', key: 'platform' } as const, {
  url: '',
  isReachable: false,
})
const deployments = atom({ plugin: 'uniform', key: 'deployments' } as const, [] as Deployment[])
const watching = atom({ plugin: 'uniform', key: 'watching' } as const, null as string | null)

// One module instance serves one session, so this is that session's own
// poll loop: which platform it asks, whether a read is in flight, and the
// timer for the next one.
let config: PlatformConfig = { url: DEFAULT_URL, token: '' }
let isPolling = false
let isWatching = false
let tick: Timer | null = null

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the Uniform platform deployments in a pane',
    })
    await registerTools($)
    // Publish the configured platform before the first read, so the pane names
    // where it is looking even when nothing has answered yet.
    await update($, platform, () => ({ url: config.url, isReachable: false }))
    startWatching($)

    return next(e)
  })

  on('session.end', ($, e, next) => {
    stopWatching()

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const opened = await $.ui.open({ id: PANE_ID, title: 'Uniform deployments' })
    await poll($)

    const info = await read($, platform)
    if (!info.isReachable) {
      return { text: `Uniform: no platform at ${config.url}. Set Platform URL in /config.` }
    }

    const list = await read($, deployments)
    if (!opened.isPlaced) {
      return { text: 'Uniform: widen the terminal to see the deployments pane.' }
    }
    if (list.length === 0) {
      return { text: 'Uniform: no deployments yet.' }
    }

    return { text: `Uniform: ${list.length} deployment(s), ${countActive(list)} moving.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Link, Text } = $.ui.resolve(e)
    const info = await read($, platform)
    const list = await read($, deployments)
    const tracked = await read($, watching)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)

    if (!info.isReachable) {
      return (
        <Box flexDirection="column">
          <Text color="error">No platform at {info.url}</Text>
          <Text dimColor>Set Platform URL and API token in /config.</Text>
        </Box>
      )
    }

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No deployments yet.</Text>
          <Link href={info.url} label={info.url} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Link href={info.url} label={info.url} />
        {list.slice(0, room).map(one => (
          <Text key={one.id} dimColor={isTerminal(one.status)}>
            {one.id === tracked ? '* ' : '  '}
            {nameOf(one)} — {labelOf(one)}
            {progressSuffix(one)}
          </Text>
        ))}
      </Box>
    )
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_list` }, async ($, e, next) => {
    void next
    void e

    return listTool($)
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_deploy` }, async ($, e, next) => {
    void next

    return deployTool($, e as unknown as Record<string, unknown>)
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_status` }, async ($, e, next) => {
    void next

    return statusTool($, e as unknown as Record<string, unknown>)
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_logs` }, async ($, e, next) => {
    void next

    return logsTool($, e as unknown as Record<string, unknown>)
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_metrics` }, async ($, e, next) => {
    void next
    void e

    return metricsTool($)
  })

  on('tool.call', { tool: `mcp__${PLUGIN}__uniform_stop` }, async ($, e, next) => {
    void next

    return stopTool($, e as unknown as Record<string, unknown>)
  })
}

/** Reads the platform once and republishes what it answered. */
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const answered = await listDeployments(send($), config)
    if (!answered.isOk) {
      await update($, platform, () => ({ url: config.url, isReachable: false }))
      $.ui.status(unreachableStatus(answered.status))
      return
    }

    await update($, platform, () => ({ url: config.url, isReachable: true }))
    await update($, deployments, () => answered.value)

    const tracked = await read($, watching)
    const active = pickActive(answered.value, tracked)
    $.ui.status(active === null ? undefined : lineFor(active, tracked))
  } finally {
    isPolling = false
  }
}

/**
 * Keeps re-reading the platform until the session ends: quickly while one of
 * the deployments the session knows about is still moving, slowly once they
 * have all settled.
 *
 * Each period is asked for only after the previous read came back, so a slow
 * platform slows the poll instead of stacking calls behind it.
 */
function startWatching($: EngineInterface): void {
  if (isWatching) return
  isWatching = true

  const beat = (): void => {
    void poll($).then(async () => {
      if (!isWatching) return
      const list = await read($, deployments)
      const ms = list.some(one => !isTerminal(one.status)) ? POLL_MS : IDLE_POLL_MS
      tick = $.clock.after(ms, beat)
    })
  }

  tick = $.clock.after(POLL_MS, beat)
}

function stopWatching(): void {
  isWatching = false
  tick?.cancel()
  tick = null
}

/** The tools the model can call. Each answers from the platform, not `$.state`. */
async function registerTools($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'uniform_list',
    description:
      'List the model deployments the Uniform platform knows about, with each ' +
      "one's id, model, stage and progress.",
    isDeferred: false,
    inputSchema: { type: 'object', properties: {} },
  })

  await $.tool.register({
    name: 'uniform_deploy',
    description:
      'Deploy a model through the Uniform platform. Answers as soon as the ' +
      'platform queues it, which is well before the server is serving: follow it ' +
      'with uniform_status or uniform_logs. Only model_id is required; every ' +
      "other parameter keeps the platform's own default.",
    isDeferred: false,
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
    isDeferred: false,
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
    isDeferred: false,
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
    isDeferred: false,
    inputSchema: { type: 'object', properties: {} },
  })

  await $.tool.register({
    name: 'uniform_stop',
    description:
      'Stop a deployment through the platform. Confirm with the person first ' +
      'unless they asked for this stop.',
    isDeferred: false,
    inputSchema: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'Defaults to the current one.' },
      },
    },
  })
}

async function listTool($: EngineInterface) {
  const answered = await listDeployments(send($), config)
  if (!answered.isOk) return failed(answered.reason)
  if (answered.value.length === 0) return ok('No deployments.')

  return ok(
    answered.value
      .map(one => `${one.id}  ${nameOf(one)}  ${labelOf(one)}${progressSuffix(one)}`)
      .join('\n'),
  )
}

async function deployTool($: EngineInterface, input: Record<string, unknown>) {
  const modelId = input.model_id
  if (typeof modelId !== 'string' || modelId.trim() === '') {
    return failed('model_id is required, such as "Qwen/Qwen3-8B".')
  }

  const answered = await createDeployment(send($), config, deployPayload(input, modelId))
  if (!answered.isOk) return failed(answered.reason)

  await update($, watching, () => answered.value.id)
  await poll($)

  return ok(
    `Queued ${nameOf(answered.value)} as deployment ${answered.value.id}. Follow it ` +
      'with uniform_status or uniform_logs; the status line tracks it.',
  )
}

async function statusTool($: EngineInterface, input: Record<string, unknown>) {
  const target = await resolveTarget($, input.deployment_id)
  if (!target.isOk) return failed(target.reason)

  const answered = await getDeployment(send($), config, target.value)
  if (!answered.isOk) return failed(answered.reason)

  return ok(describeDeployment(answered.value))
}

async function logsTool($: EngineInterface, input: Record<string, unknown>) {
  const target = await resolveTarget($, input.deployment_id)
  if (!target.isOk) return failed(target.reason)

  const asked = typeof input.tail === 'number' ? Math.trunc(input.tail) : LOG_TAIL
  const tail = Math.min(Math.max(asked, 1), LOG_TAIL_MAX)

  const answered = await deploymentLogs(send($), config, target.value, tail)
  if (!answered.isOk) return failed(answered.reason)
  if (answered.value.trim() === '') return ok(`No log lines for ${target.value} yet.`)

  return ok(answered.value)
}

async function metricsTool($: EngineInterface) {
  const answered = await systemMetrics(send($), config)
  if (!answered.isOk) return failed(answered.reason)

  return ok(JSON.stringify(answered.value, null, 2))
}

async function stopTool($: EngineInterface, input: Record<string, unknown>) {
  const target = await resolveTarget($, input.deployment_id)
  if (!target.isOk) return failed(target.reason)

  const answered = await stopDeployment(send($), config, target.value)
  if (!answered.isOk) return failed(answered.reason)

  await poll($)

  return ok(`${nameOf(answered.value)} (${answered.value.id}) is ${labelOf(answered.value)}.`)
}

/**
 * The deployment a call means when it named none: the one this session is
 * watching, else the newest the platform holds.
 */
async function resolveTarget(
  $: EngineInterface,
  named: unknown,
): Promise<PlatformResult<string>> {
  if (typeof named === 'string' && named.trim() !== '') {
    return { isOk: true, value: named.trim() }
  }

  const tracked = await read($, watching)
  if (tracked !== null) return { isOk: true, value: tracked }

  const known = await read($, deployments)
  const known0 = known[0]
  if (known0 !== undefined) return { isOk: true, value: known0.id }

  const answered = await listDeployments(send($), config)
  if (answered.isOk) {
    const newest = answered.value[0]
    if (newest !== undefined) return { isOk: true, value: newest.id }
  }

  return { isOk: false, status: null, reason: 'no deployment to act on; pass deployment_id.' }
}

/** The tool's answer: the text the model reads. */
function ok(text: string) {
  return { result: text }
}

/**
 * A refusal: the model reads the platform's own words as an error result, the
 * way it reads a built-in tool that failed. The engine holds a plugin tool's
 * result to a string, an array or nothing — never the `{ content, isError }`
 * envelope an MCP server sends — so an error is denied rather than wrapped.
 */
function failed(reason: string) {
  return { deny: reason }
}

/** The plugin's options as the client wants them: two strings, always. */
function configFrom(options: PluginOptions): PlatformConfig {
  const url = typeof options.platform_url === 'string' ? options.platform_url.trim() : ''
  const token = typeof options.api_token === 'string' ? options.api_token.trim() : ''

  return { url: (url === '' ? DEFAULT_URL : url).replace(/\/+$/, ''), token }
}

/**
 * The engine's own fetch, handed to the client as a plain function.
 *
 * The engine lets `$` be passed only into a function declared in this file, so
 * this wrapper is how a hook's `$` reaches the client without the client ever
 * touching `$` itself.
 */
function send($: EngineInterface): Transport {
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

/** The deployment the status line should follow, if any. */
function pickActive(list: readonly Deployment[], tracked: string | null): Deployment | null {
  if (tracked !== null) {
    const named = list.find(one => one.id === tracked)
    if (named !== undefined && !isTerminal(named.status)) return named
  }

  return list.find(one => !isTerminal(one.status)) ?? null
}

function countActive(list: readonly Deployment[]): number {
  return list.filter(one => !isTerminal(one.status)).length
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

function progressSuffix(one: Deployment): string {
  return isTerminal(one.status) ? '' : ` ${percentOf(one)}%`
}

/** The status line's own words when the platform did not answer at all. */
function unreachableStatus(status: number | null): string {
  if (status === 401 || status === 403) return `${PLUGIN}: the API token was refused`

  return `${PLUGIN}: the platform is unreachable`
}

/** The status line's words for one deployment. */
function lineFor(one: Deployment, tracked: string | null): string {
  const mark = one.id === tracked ? '*' : ''

  return `${PLUGIN}${mark}: ${nameOf(one)} ${labelOf(one)} ${percentOf(one)}%`
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
