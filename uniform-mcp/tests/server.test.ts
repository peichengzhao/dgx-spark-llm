// The server's tests, through the MCP SDK's own client. Most talk to the server
// in memory with the platform answered from fixed bodies; the last ones start
// the built dist/index.mjs over stdio, as an agent does, against a platform
// stood up on a local port.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, test } from 'vitest'

import { createUniformServer } from '../src/server'

const URL = 'http://spark.local:18180'

const DEPLOYMENT = {
  id: 'a1b2c3d4',
  model_id: 'Qwen/Qwen3-8B',
  revision: null,
  display_name: null,
  status: 'loading_model',
  progress: 0.78,
  error_code: null,
  error_message: null,
  attempt: 0,
  version: 3,
  created_at: '2026-10-12T13:00:00Z',
}

type Answered = { status: number; body: string }
type Asked = { method: string; url: string; body: string; headers: Record<string, string> }

const open: Client[] = []

afterEach(async () => {
  await Promise.all(open.splice(0).map(client => client.close()))
})

/** The server behind an in-memory client, with the platform answered by path; anything else is a 404. */
async function connect(answers: Record<string, Answered>, options: { url?: string; token?: string } = { url: URL }) {
  const asked: Asked[] = []
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    asked.push({
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? init.body : '',
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const answered = answers[url.replace(options.url ?? URL, '')] ?? { status: 404, body: '{"detail":"not found"}' }

    return new Response(answered.body, { status: answered.status })
  }) as typeof fetch

  const client = await connected(createUniformServer({ ...options, fetch: fakeFetch }))

  return { client, asked }
}

async function connected(server: ReturnType<typeof createUniformServer>): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  open.push(client)

  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')

  return { text, isError: result.isError === true }
}

function listing(...items: object[]): Answered {
  return { status: 200, body: JSON.stringify({ items, total: items.length }) }
}

describe('the server', () => {
  test('offers the six tools, with hints about which ones change anything', async () => {
    const { client } = await connect({})

    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))

    expect(Object.keys(byName).sort()).toEqual([
      'uniform_deploy',
      'uniform_list',
      'uniform_logs',
      'uniform_metrics',
      'uniform_status',
      'uniform_stop',
    ])
    expect(byName.uniform_deploy?.inputSchema.required).toEqual(['model_id'])
    expect(byName.uniform_list?.annotations?.readOnlyHint).toBe(true)
    expect(byName.uniform_stop?.annotations?.destructiveHint).toBe(true)
  })

  test('tells the agent how the tools fit together', async () => {
    const { client } = await connect({})

    expect(client.getInstructions()).toContain('uniform_status')
    expect(client.getServerVersion()?.name).toBe('uniform')
  })
})

describe('tools', () => {
  test('uniform_list reads the platform and names what it holds', async () => {
    const { client, asked } = await connect({ '/api/v1/deployments?limit=50': listing(DEPLOYMENT) })

    const answered = await call(client, 'uniform_list')

    expect(asked.map(one => one.url)).toEqual([`${URL}/api/v1/deployments?limit=50`])
    expect(answered).toEqual({ text: 'a1b2c3d4  Qwen/Qwen3-8B  loading the model 78%', isError: false })
  })

  test('falls back to the platform on this machine, and drops a trailing slash', async () => {
    const local = await connect({ '/api/v1/deployments?limit=50': listing() }, { url: 'http://127.0.0.1:18180' })
    const slashed = await connect({ '/api/v1/deployments?limit=50': listing() }, { url: `${URL}/` })

    await call(local.client, 'uniform_list')
    await call(slashed.client, 'uniform_list')

    expect(local.asked[0]?.url).toBe('http://127.0.0.1:18180/api/v1/deployments?limit=50')
    expect(slashed.asked[0]?.url).toBe(`${URL}/api/v1/deployments?limit=50`)
  })

  test('sends the API token as X-API-Key, and none when there is no token', async () => {
    const withToken = await connect({ '/api/v1/deployments?limit=50': listing() }, { url: URL, token: ' secret ' })
    const without = await connect({ '/api/v1/deployments?limit=50': listing() })

    await call(withToken.client, 'uniform_list')
    await call(without.client, 'uniform_list')

    expect(withToken.asked[0]?.headers['X-API-Key']).toBe('secret')
    expect(without.asked[0]?.headers).not.toHaveProperty('X-API-Key')
  })

  test('uniform_deploy carries only what the call passed', async () => {
    const { client, asked } = await connect({ '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) } })

    const answered = await call(client, 'uniform_deploy', { model_id: ' Qwen/Qwen3-8B ', port: 8199 })

    const posted = asked.find(one => one.method === 'POST')
    expect(posted?.url).toBe(`${URL}/api/v1/deployments`)
    expect(JSON.parse(posted?.body ?? '{}')).toEqual({ model_id: 'Qwen/Qwen3-8B', parameters: { port: 8199 } })
    expect(answered.text).toContain('Queued Qwen/Qwen3-8B as deployment a1b2c3d4')
  })

  test('uniform_deploy acknowledges remote code when it is allowed', async () => {
    const { client, asked } = await connect({ '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) } })

    await call(client, 'uniform_deploy', { model_id: 'Qwen/Qwen3-8B', trust_remote_code: true })

    expect(JSON.parse(asked[0]?.body ?? '{}').parameters).toEqual({
      trust_remote_code: true,
      remote_code_acknowledged: true,
    })
  })

  test('a blank model_id is refused before the platform is asked', async () => {
    const { client, asked } = await connect({})

    const answered = await call(client, 'uniform_deploy', { model_id: '  ' })

    expect(answered.isError).toBe(true)
    expect(answered.text).toContain('model_id')
    expect(asked).toEqual([])
  })

  test('arguments of the wrong type never reach the platform', async () => {
    const { client, asked } = await connect({})

    const answered = await call(client, 'uniform_deploy', { model_id: 'Qwen/Qwen3-8B', port: 'eighty' })

    expect(answered.isError).toBe(true)
    expect(asked).toEqual([])
  })

  test("a tool carries the platform's own words when it refuses", async () => {
    const { client } = await connect({
      '/api/v1/deployments/no-such-id': { status: 404, body: '{"detail":"deployment not found"}' },
    })

    expect(await call(client, 'uniform_status', { deployment_id: 'no-such-id' })).toEqual({
      text: 'deployment not found',
      isError: true,
    })
  })

  test('a validation failure from the platform reaches the model as it was sent', async () => {
    const detail = [{ loc: ['body', 'model_id'], msg: 'field required' }]
    const { client } = await connect({ '/api/v1/deployments': { status: 422, body: JSON.stringify({ detail }) } })

    const answered = await call(client, 'uniform_deploy', { model_id: 'x' })

    expect(answered.isError).toBe(true)
    expect(answered.text).toBe(JSON.stringify(detail))
  })

  test('uniform_status describes one deployment, with its error', async () => {
    const { client } = await connect({
      '/api/v1/deployments/a1b2c3d4': {
        status: 200,
        body: JSON.stringify({ ...DEPLOYMENT, status: 'failed', error_message: 'CUDA out of memory' }),
      },
    })

    const answered = await call(client, 'uniform_status', { deployment_id: 'a1b2c3d4' })

    expect(answered.text).toContain('status: failed')
    expect(answered.text).toContain('error: CUDA out of memory')
  })

  test('uniform_status follows what this session deployed, before the newest', async () => {
    const other = { ...DEPLOYMENT, id: 'e5f6a7b8' }
    const { client, asked } = await connect({
      '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) },
      '/api/v1/deployments?limit=50': listing(other, DEPLOYMENT),
      '/api/v1/deployments/a1b2c3d4': { status: 200, body: JSON.stringify(DEPLOYMENT) },
      '/api/v1/deployments/e5f6a7b8': { status: 200, body: JSON.stringify(other) },
    })

    const before = await call(client, 'uniform_status')
    await call(client, 'uniform_deploy', { model_id: 'Qwen/Qwen3-8B' })
    const after = await call(client, 'uniform_status')

    expect(before.text).toContain('deployment: e5f6a7b8')
    expect(after.text).toContain('deployment: a1b2c3d4')
    expect(asked.map(one => one.url)).toContain(`${URL}/api/v1/deployments/a1b2c3d4`)
  })

  test('a tool that was given no deployment says which one to name', async () => {
    const { client } = await connect({ '/api/v1/deployments?limit=50': listing() })

    const answered = await call(client, 'uniform_logs')

    expect(answered.isError).toBe(true)
    expect(answered.text).toContain('deployment_id')
  })

  test('uniform_logs reads the tail it was asked for, within bounds', async () => {
    const { client, asked } = await connect({
      '/api/v1/deployments/a1b2c3d4/logs?tail=50': { status: 200, body: '{"logs":"line one\\nline two"}' },
      '/api/v1/deployments/a1b2c3d4/logs?tail=2000': { status: 200, body: '{"logs":""}' },
      '/api/v1/deployments/a1b2c3d4/logs?tail=200': { status: 200, body: '{"logs":"default"}' },
    })

    const fifty = await call(client, 'uniform_logs', { deployment_id: 'a1b2c3d4', tail: 50 })
    const many = await call(client, 'uniform_logs', { deployment_id: 'a1b2c3d4', tail: 99_999 })
    const unnamed = await call(client, 'uniform_logs', { deployment_id: 'a1b2c3d4' })

    expect(fifty.text).toBe('line one\nline two')
    expect(asked.map(one => one.url)).toContain(`${URL}/api/v1/deployments/a1b2c3d4/logs?tail=2000`)
    expect(many.text).toBe('No log lines for a1b2c3d4 yet.')
    expect(unnamed.text).toBe('default')
  })

  test('uniform_metrics reports what the platform sampled', async () => {
    const { client } = await connect({
      '/api/v1/system/metrics': { status: 200, body: '{"gpu":{"name":"NVIDIA GB10"}}' },
    })

    expect((await call(client, 'uniform_metrics')).text).toContain('"name": "NVIDIA GB10"')
  })

  test('uniform_stop stops the deployment the session deployed', async () => {
    const { client, asked } = await connect({
      '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) },
      '/api/v1/deployments/a1b2c3d4/stop': {
        status: 200,
        body: JSON.stringify({ ...DEPLOYMENT, status: 'stopping' }),
      },
    })

    await call(client, 'uniform_deploy', { model_id: 'Qwen/Qwen3-8B' })
    const answered = await call(client, 'uniform_stop')

    expect(asked.at(-1)).toMatchObject({ method: 'POST', url: `${URL}/api/v1/deployments/a1b2c3d4/stop` })
    expect(answered.text).toBe('Qwen/Qwen3-8B (a1b2c3d4) is stopping.')
  })

  test('a platform that does not answer is reported with its URL and reason', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const client = await connected(
      createUniformServer({ url: URL, fetch: (() => Promise.reject(refused)) as unknown as typeof fetch }),
    )

    expect(await call(client, 'uniform_list')).toEqual({
      text: `cannot reach ${URL}: fetch failed (ECONNREFUSED)`,
      isError: true,
    })
  })

  test('a platform that hangs is given up on after the timeout', async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    const client = await connected(createUniformServer({ url: URL, fetch: hang, timeoutMs: 50 }))

    expect((await call(client, 'uniform_metrics')).text).toBe(`cannot reach ${URL}: no answer within 0.05s`)
  })
})

describe('the built server over stdio', () => {
  let platform: Server | undefined

  afterEach(async () => {
    await new Promise(resolve => platform?.close(resolve) ?? resolve(undefined))
    platform = undefined
  })

  async function start(env: Record<string, string>) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new globalThis.URL('../dist/index.mjs', import.meta.url))],
      env: { PATH: process.env.PATH ?? '', ...env },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)
    open.push(client)

    return client
  }

  test('deploys through a real platform port with the configured token', async () => {
    const seen: { method?: string; url?: string; key?: string | string[]; body: string }[] = []
    platform = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => (body += chunk))
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, key: req.headers['x-api-key'], body })
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(DEPLOYMENT))
      })
    })
    await new Promise<void>(resolve => platform?.listen(0, '127.0.0.1', resolve))
    const { port } = platform.address() as AddressInfo

    const client = await start({ UNIFORM_URL: `http://127.0.0.1:${port}`, UNIFORM_API_TOKEN: 'tok' })
    const answered = await call(client, 'uniform_deploy', { model_id: 'Qwen/Qwen3-8B' })

    expect(answered.text).toContain('deployment a1b2c3d4')
    expect(seen).toEqual([
      { method: 'POST', url: '/api/v1/deployments', key: 'tok', body: '{"model_id":"Qwen/Qwen3-8B","parameters":{}}' },
    ])
  })

  test('says where it looked when nothing listens there', async () => {
    const vacated = createServer()
    await new Promise<void>(resolve => vacated.listen(0, '127.0.0.1', resolve))
    const { port } = vacated.address() as AddressInfo
    await new Promise(resolve => vacated.close(resolve))

    const client = await start({ UNIFORM_URL: `http://127.0.0.1:${port}` })
    const answered = await call(client, 'uniform_list')

    expect(answered.isError).toBe(true)
    expect(answered.text).toBe(`cannot reach http://127.0.0.1:${port}: fetch failed (ECONNREFUSED)`)
  })
})
