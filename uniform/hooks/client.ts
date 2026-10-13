// A client for the Uniform control service.
//
// This plugin is a remote client and nothing more: the platform runs where it
// runs (a DGX Spark on the same machine, or one reached over an SSH tunnel),
// and everything here goes over its REST API. The plugin never touches Docker,
// the model cache or the worker; it asks the platform, which owns the safety
// rules for what a session is allowed to do.
//
// The transport is the host's (`$.http.fetch`), so the person's web-fetch
// policy still applies, and the token is the one they configured in the
// plugin's own settings; this module never writes it anywhere.

import type { Deployment, DeploymentStatus } from '../types'

/** Where the platform lives and what it holds for a request. */
export type PlatformConfig = {
  url: string
  token: string
}

/**
 * What this plugin maps onto the platform's API.
 *
 * The platform's error contract is its own (a JSON `{ detail }` body with a
 * 4xx/5xx status), so every failure here carries the status and, where the
 * platform sent one, its detail text; a transport failure carries neither.
 */
export type PlatformResult<T> =
  | { isOk: true; value: T }
  | { isOk: false; status: number | null; reason: string }

/** A query string that keeps a listing bounded, whatever the platform holds. */
export const LIST_PATH = '/api/v1/deployments?limit=50'

/** The deployments the platform knows about, newest first. */
export async function listDeployments(
  send: Transport,
  config: PlatformConfig,
): Promise<PlatformResult<Deployment[]>> {
  const body = await request(send, config, 'GET', LIST_PATH)
  if (!body.isOk) return body

  const items = (body.value as { items?: unknown }).items
  if (!Array.isArray(items)) {
    return { isOk: false, status: null, reason: 'the platform returned no deployment list' }
  }

  return { isOk: true, value: items as Deployment[] }
}

/** One deployment by id, as the platform reports it now. */
export async function getDeployment(
  send: Transport,
  config: PlatformConfig,
  id: string,
): Promise<PlatformResult<Deployment>> {
  const body = await request(send, config, 'GET', `/api/v1/deployments/${encodeURIComponent(id)}`)
  if (!body.isOk) return body

  return { isOk: true, value: body.value as Deployment }
}

/**
 * Starts a deployment of one model and answers with it, queued.
 *
 * Only the fields the caller passed are sent: every other parameter takes the
 * platform's own default, and an unknown model or bad parameter is the
 * platform's to refuse, in its own words.
 */
export async function createDeployment(
  send: Transport,
  config: PlatformConfig,
  payload: Record<string, unknown>,
): Promise<PlatformResult<Deployment>> {
  const body = await request(send, config, 'POST', '/api/v1/deployments', payload)
  if (!body.isOk) return body

  return { isOk: true, value: body.value as Deployment }
}

/** Stops a deployment; the platform keeps the container's records. */
export async function stopDeployment(
  send: Transport,
  config: PlatformConfig,
  id: string,
): Promise<PlatformResult<Deployment>> {
  const body = await request(
    send,
    config,
    'POST',
    `/api/v1/deployments/${encodeURIComponent(id)}/stop`,
  )
  if (!body.isOk) return body

  return { isOk: true, value: body.value as Deployment }
}

/** The tail of the container log the platform kept for one deployment. */
export async function deploymentLogs(
  send: Transport,
  config: PlatformConfig,
  id: string,
  tail: number,
): Promise<PlatformResult<string>> {
  const body = await request(
    send,
    config,
    'GET',
    `/api/v1/deployments/${encodeURIComponent(id)}/logs?tail=${tail}`,
  )
  if (!body.isOk) return body

  const logs = (body.value as { logs?: unknown }).logs
  return { isOk: true, value: typeof logs === 'string' ? logs : '' }
}

/** A machine's CPU, GPU and unified-memory picture, as the platform samples it. */
export async function systemMetrics(
  send: Transport,
  config: PlatformConfig,
): Promise<PlatformResult<Record<string, unknown>>> {
  const body = await request(send, config, 'GET', '/api/v1/system/metrics')
  if (!body.isOk) return body

  return { isOk: true, value: body.value as Record<string, unknown> }
}

/**
 * One request, with the token when there is one, and the platform's own error
 * text kept as the reason wherever it sent one.
 */
async function request(
  send: Transport,
  config: PlatformConfig,
  method: string,
  path: string,
  payload?: Record<string, unknown>,
): Promise<PlatformResult<unknown>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.token !== '') headers['X-API-Key'] = config.token
  if (payload !== undefined) headers['Content-Type'] = 'application/json'

  let response: { status: number; ok: boolean; text: string }
  try {
    response = await send(`${config.url}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    })
  } catch (error) {
    return { isOk: false, status: null, reason: `cannot reach ${config.url}: ${describe(error)}` }
  }

  const parsed = parseJson(response.text)

  if (!response.ok) {
    return {
      isOk: false,
      status: response.status,
      reason: detailOf(parsed) ?? `the platform answered HTTP ${response.status}`,
    }
  }

  if (parsed === undefined) {
    return { isOk: false, status: response.status, reason: 'the platform sent no JSON body' }
  }

  return { isOk: true, value: parsed }
}

/** The platform's `detail` field, whatever shape it arrived in. */
function detailOf(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null

  const detail = (parsed as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  // A validation failure arrives as a list of per-field objects.
  if (Array.isArray(detail)) return JSON.stringify(detail)

  return null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The stage names a person reads, for the platform's own names. */
export const STATUS_LABELS: Record<DeploymentStatus, string> = {
  queued: 'queued',
  preflight: 'checking the machine',
  downloading_model: 'downloading weights',
  pulling_image: 'pulling the image',
  starting_container: 'starting the container',
  loading_model: 'loading the model',
  health_checking: 'health-checking',
  running: 'running',
  stopping: 'stopping',
  stopped: 'stopped',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** Stages whose next change comes from a person, not from the worker. */
const TERMINAL: readonly DeploymentStatus[] = ['stopped', 'failed', 'cancelled']

export function isTerminal(status: DeploymentStatus): boolean {
  return TERMINAL.includes(status)
}

/**
 * How this module reaches the platform: one call, and the caller supplies it.
 *
 * The hooks module hands in the engine's own `$.http.fetch` here, because the
 * engine lets `$` be passed only into a function declared in that same file —
 * never across an import. Keeping the client to one plain function also means
 * it can be exercised with a stand-in.
 */
export type Transport = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<{ status: number; ok: boolean; text: string }>
