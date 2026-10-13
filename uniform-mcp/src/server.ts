// The Uniform DGX Spark platform as an MCP server.
//
// The same remote client as `../../uniform` and `../../uniform-dsh`, behind the
// one extension point every agent shares: the six tools, over MCP. The server
// only talks to a platform that is already running, over its REST API; it
// never starts it and never touches Docker or the model cache. A stdio server
// lives as long as the agent session that started it, so the deployment the
// session last acted on is simply held here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

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

export const VERSION = '0.1.0'
/** The platform on this machine, so a local agent needs no setup. */
export const DEFAULT_URL = 'http://127.0.0.1:18180'
/** How long one platform request may take before the tool reports it unreachable. */
const REQUEST_TIMEOUT_MS = 30_000
/** The log tail a call gets when it named none, and the most one may ask for. */
const LOG_TAIL = 200
const LOG_TAIL_MAX = 2_000

const INSTRUCTIONS =
  'Tools for a Uniform DGX Spark platform, which runs vLLM model deployments. ' +
  'uniform_deploy returns as soon as the platform queues a deployment, long before ' +
  'it serves: follow it with uniform_status, and read uniform_logs when it stalls ' +
  'or fails. uniform_status, uniform_logs and uniform_stop default to the ' +
  'deployment this session last deployed or stopped.'

export type UniformServerOptions = {
  /** Base URL of the Uniform control service. */
  url?: string
  /** The platform's UNIFORM_API_TOKEN, sent as X-API-Key; empty when it runs without one. */
  token?: string
  /** The fetch to reach the platform with. */
  fetch?: typeof fetch
  timeoutMs?: number
}

export function createUniformServer(options: UniformServerOptions = {}): McpServer {
  const config = configFrom(options)
  const send = transport(options.fetch ?? fetch, options.timeoutMs ?? REQUEST_TIMEOUT_MS)
  let watching: string | null = null

  const server = new McpServer({ name: 'uniform', version: VERSION }, { instructions: INSTRUCTIONS })

  /**
   * The deployment a call means when it named none: the one this session last
   * acted on, else the newest the platform holds.
   */
  async function resolveTarget(named: string | undefined): Promise<PlatformResult<string>> {
    if (named !== undefined && named.trim() !== '') return { isOk: true, value: named.trim() }
    if (watching !== null) return { isOk: true, value: watching }

    const answered = await listDeployments(send, config)
    const newest = answered.isOk ? answered.value[0] : undefined
    if (newest !== undefined) return { isOk: true, value: newest.id }
    if (!answered.isOk) return answered

    return { isOk: false, status: null, reason: 'no deployment to act on; pass deployment_id.' }
  }

  const deploymentId = z.string().optional().describe('Defaults to the current one.')

  server.registerTool(
    'uniform_list',
    {
      title: 'List deployments',
      description:
        'List the model deployments the Uniform platform knows about, with each ' +
        "one's id, model, stage and progress.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const answered = await listDeployments(send, config)
      if (!answered.isOk) return failed(answered.reason)
      if (answered.value.length === 0) return ok('No deployments.')

      return ok(answered.value.map(listLine).join('\n'))
    },
  )

  server.registerTool(
    'uniform_deploy',
    {
      title: 'Deploy a model',
      description:
        'Deploy a model through the Uniform platform. Answers as soon as the ' +
        'platform queues it, which is well before the server is serving: follow it ' +
        'with uniform_status or uniform_logs. Only model_id is required; every ' +
        "other parameter keeps the platform's own default.",
      inputSchema: {
        model_id: z
          .string()
          .describe(
            'The model to deploy, such as "Qwen/Qwen3-8B": a Hugging Face or ' +
              'ModelScope repository id, or any id the platform can resolve.',
          ),
        source: z
          .enum(['huggingface', 'modelscope'])
          .optional()
          .describe('Where to fetch the weights from; defaults to huggingface.'),
        local_model_path: z
          .string()
          .optional()
          .describe(
            'An absolute path to weights already on the machine, to deploy those ' +
              'instead of downloading them.',
          ),
        port: z.number().int().optional().describe('Host port for the API; default 8000.'),
        image: z.string().optional().describe('The inference container image to run.'),
        max_model_len: z.number().int().optional().describe('The longest context the server will accept, in tokens.'),
        gpu_memory_utilization: z
          .number()
          .optional()
          .describe('The fraction of GPU memory the server may claim; default 0.9.'),
        trust_remote_code: z
          .boolean()
          .optional()
          .describe(
            'Allow the model repository to run its own Python on this machine. ' +
              'Only for a repository the person trusts.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async input => {
      if (input.model_id.trim() === '') return failed('model_id is required, such as "Qwen/Qwen3-8B".')

      const answered = await createDeployment(send, config, deployPayload(input))
      if (!answered.isOk) return failed(answered.reason)

      watching = answered.value.id

      return ok(
        `Queued ${nameOf(answered.value)} as deployment ${answered.value.id}. Follow it ` +
          'with uniform_status or uniform_logs.',
      )
    },
  )

  server.registerTool(
    'uniform_status',
    {
      title: 'Deployment status',
      description:
        'Report one deployment in detail: model, stage, progress, attempts and any ' +
        'error. Defaults to the deployment this session is watching, else the most ' +
        'recent one.',
      inputSchema: { deployment_id: deploymentId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async input => {
      const target = await resolveTarget(input.deployment_id)
      if (!target.isOk) return failed(target.reason)

      const answered = await getDeployment(send, config, target.value)
      if (!answered.isOk) return failed(answered.reason)

      return ok(describeDeployment(answered.value))
    },
  )

  server.registerTool(
    'uniform_logs',
    {
      title: 'Deployment logs',
      description:
        'Read the container log the platform kept for a deployment — where a ' +
        'download, a container start or a model load reports why it stalled or failed.',
      inputSchema: {
        deployment_id: deploymentId,
        tail: z.number().int().optional().describe(`Lines to read; default ${LOG_TAIL}, at most ${LOG_TAIL_MAX}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async input => {
      const target = await resolveTarget(input.deployment_id)
      if (!target.isOk) return failed(target.reason)

      const tail = Math.min(Math.max(input.tail ?? LOG_TAIL, 1), LOG_TAIL_MAX)
      const answered = await deploymentLogs(send, config, target.value, tail)
      if (!answered.isOk) return failed(answered.reason)
      if (answered.value.trim() === '') return ok(`No log lines for ${target.value} yet.`)

      return ok(answered.value)
    },
  )

  server.registerTool(
    'uniform_metrics',
    {
      title: 'Machine metrics',
      description:
        "The machine's CPU, GPU, unified memory, disk and network, as the platform " +
        'samples them.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const answered = await systemMetrics(send, config)
      if (!answered.isOk) return failed(answered.reason)

      return ok(JSON.stringify(answered.value, null, 2))
    },
  )

  server.registerTool(
    'uniform_stop',
    {
      title: 'Stop a deployment',
      description:
        'Stop a deployment through the platform. Confirm with the person first ' +
        'unless they asked for this stop.',
      inputSchema: { deployment_id: deploymentId },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async input => {
      const target = await resolveTarget(input.deployment_id)
      if (!target.isOk) return failed(target.reason)

      const answered = await stopDeployment(send, config, target.value)
      if (!answered.isOk) return failed(answered.reason)

      watching = answered.value.id

      return ok(`${nameOf(answered.value)} (${answered.value.id}) is ${labelOf(answered.value)}.`)
    },
  )

  return server
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

/** The platform's own words, as a tool error the model reads. */
function failed(reason: string): CallToolResult {
  return { content: [{ type: 'text', text: reason }], isError: true }
}

function configFrom(options: UniformServerOptions): PlatformConfig {
  const url = options.url?.trim() ?? ''
  const token = options.token?.trim() ?? ''

  return { url: (url === '' ? DEFAULT_URL : url).replace(/\/+$/, ''), token }
}

/**
 * Node's fetch as the client wants it. A request that cannot reach the platform
 * throws with the underlying reason (`ECONNREFUSED`, a timeout), which the
 * client reports beside the platform's URL.
 */
function transport(fetchFn: typeof fetch, timeoutMs: number): Transport {
  return async (url, init) => {
    try {
      const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })

      return { status: response.status, ok: response.ok, text: await response.text() }
    } catch (error) {
      throw new Error(reasonOf(error, timeoutMs))
    }
  }
}

function reasonOf(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `no answer within ${timeoutMs / 1000}s`

  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined
  const detail = typeof cause?.code === 'string' ? cause.code : cause?.message

  return typeof detail === 'string' && detail !== '' ? `${message} (${detail})` : message
}

/**
 * The body `POST /api/v1/deployments` takes. Only the fields the call actually
 * passed are sent, so every other parameter keeps the platform's own default
 * rather than being pinned to a copy of it here.
 */
function deployPayload(input: Record<string, unknown> & { model_id: string }): Record<string, unknown> {
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

  return { model_id: input.model_id.trim(), parameters }
}

function nameOf(one: Deployment): string {
  return one.display_name ?? one.model_id
}

function labelOf(one: Deployment): string {
  return STATUS_LABELS[one.status] ?? one.status
}

function listLine(one: Deployment): string {
  const progress = isTerminal(one.status) || one.status === 'running' ? '' : ` ${Math.round(one.progress * 100)}%`

  return `${one.id}  ${nameOf(one)}  ${labelOf(one)}${progress}`
}

/** One deployment, as the model reads it in a status answer. */
function describeDeployment(one: Deployment): string {
  const lines = [
    `deployment: ${one.id}`,
    `model: ${nameOf(one)}`,
    `status: ${labelOf(one)} (${Math.round(one.progress * 100)}%)`,
  ]
  if (one.error_message !== null) lines.push(`error: ${one.error_message}`)
  lines.push(`attempt: ${one.attempt}`, `created: ${one.created_at}`)

  return lines.join('\n')
}
