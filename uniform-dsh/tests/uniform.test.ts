// The mod's tests, run through the bridge's own test kit: every event goes
// through the same hook chain DeepSeek Harness runs, and the stubs below stand
// in for the harness services and for the platform, which the mod reaches only
// through `$.http.fetch`. What a running platform really says is exercised in
// a session, against one.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { createModTestKit, type ModTestKit } from '@deepseek-ai/dsh-experimental-claude-code-mods/testing'

import uniform from '../src/index'

const URL = 'http://spark.local:18180'

const TOOLS = [
  'uniform_list',
  'uniform_deploy',
  'uniform_status',
  'uniform_logs',
  'uniform_metrics',
  'uniform_stop',
]

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
type Asked = { method: string; url: string; body: string }

let kit: ModTestKit | undefined

// A hook that throws or overruns is skipped and reported rather than failing
// the event, so every test also holds the bridge to having reported nothing.
afterEach(async () => {
  const reports = kit?.reports ?? []
  await kit?.dispose()
  expect(reports).toEqual([])
  kit = undefined
})

/** The mod loaded through the bridge, with the harness services it calls stood in for. */
async function load(options: Record<string, string> = { platform_url: URL }) {
  kit = await createModTestKit({ mods: [uniform], options: { uniform: options } })

  const tools: string[] = []
  const commands: string[] = []
  kit.on('session.id', () => ({ value: 'session-1' }))
  kit.on('tool.register', (_$, e: { name: string }) => {
    tools.push(e.name)
    return { value: undefined }
  })
  kit.on('command.register', (_$, e: { name: string }) => {
    commands.push(e.name)
    return { value: undefined }
  })

  return { kit, tools, commands }
}

/** The platform, answered from fixed bodies by path; anything else is a 404. */
function platform(on: ModTestKit['on'], answers: Record<string, Answered>): Asked[] {
  const asked: Asked[] = []

  on('http.fetch', (_$, e: { url: string; init?: { method?: string; body?: string } }) => {
    asked.push({ method: e.init?.method ?? 'GET', url: e.url, body: e.init?.body ?? '' })

    const answered = answers[e.url.replace(URL, '')] ?? { status: 404, body: '{"detail":"not found"}' }
    return {
      value: {
        status: answered.status,
        ok: answered.status >= 200 && answered.status < 300,
        headers: {},
        text: answered.body,
      },
    }
  })

  return asked
}

function listing(...items: object[]): Answered {
  return { status: 200, body: JSON.stringify({ items, total: items.length }) }
}

/** The text a tool answer carries, whichever way the mod answered. */
function textOf(answered: { deny?: string; result?: unknown }): string {
  if (answered.deny !== undefined) return answered.deny
  return typeof answered.result === 'string' ? answered.result : ''
}

describe('session start', () => {
  test('the built module is the mod the profile loads', async () => {
    const entry = '../dist/index.mjs'
    const built = (await import(entry)) as { default: typeof uniform }

    expect(built.default.definition.name).toBe('uniform')
    expect(built.default.definition.options).toEqual({ platform_url: 'http://127.0.0.1:18180', api_token: '' })

    kit = await createModTestKit({ mods: [built.default] })
    kit.on('session.id', () => ({ value: 'session-1' }))
    kit.on('tool.register', () => ({ value: undefined }))
    kit.on('command.register', () => ({ value: undefined }))
    await kit.$.session.start()
  })

  test('registers the tools the model can call and the /uniform command', async () => {
    const { kit, tools, commands } = await load()
    platform(kit.on, {})

    await kit.$.session.start()

    expect(tools).toEqual(TOOLS)
    expect(commands).toEqual(['uniform'])
    expect(kit.reports).toEqual([])
  })
})

describe('tools', () => {
  test('uniform_list reads the platform and names what it holds', async () => {
    const { kit } = await load()
    const asked = platform(kit.on, { '/api/v1/deployments?limit=50': listing(DEPLOYMENT) })

    await kit.$.session.start()
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_list' })

    expect(asked.map(one => one.url)).toContain(`${URL}/api/v1/deployments?limit=50`)
    expect(textOf(answered)).toContain('a1b2c3d4')
    expect(textOf(answered)).toContain('loading the model 78%')
  })

  test('the platform falls back to this machine when none is configured', async () => {
    const { kit } = await load({})
    const asked: string[] = []
    kit.on('http.fetch', (_$, e: { url: string }) => {
      asked.push(e.url)
      return { value: { status: 200, ok: true, headers: {}, text: '{"items":[],"total":0}' } }
    })

    await kit.$.session.start()
    await kit.$.tool.call({ tool: 'mcp__uniform__uniform_list' })

    expect(asked).toContain('http://127.0.0.1:18180/api/v1/deployments?limit=50')
  })

  test('the API token travels as X-API-Key', async () => {
    const { kit } = await load({ platform_url: URL, api_token: 'secret' })
    const headers: Record<string, string>[] = []
    kit.on('http.fetch', (_$, e: { init?: { headers?: Record<string, string> } }) => {
      headers.push(e.init?.headers ?? {})
      return { value: { status: 200, ok: true, headers: {}, text: '{"items":[],"total":0}' } }
    })

    await kit.$.session.start()
    await kit.$.tool.call({ tool: 'mcp__uniform__uniform_list' })

    expect(headers[0]?.['X-API-Key']).toBe('secret')
  })

  test('uniform_deploy carries only what the call passed', async () => {
    const { kit } = await load()
    const asked = platform(kit.on, {
      '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) },
      '/api/v1/deployments?limit=50': listing(DEPLOYMENT),
    })

    await kit.$.session.start()
    const answered = await kit.$.tool.call({
      tool: 'mcp__uniform__uniform_deploy',
      model_id: 'Qwen/Qwen3-8B',
      port: 8199,
    })

    const posted = asked.find(one => one.method === 'POST')
    const sent = JSON.parse(posted?.body ?? '{}') as { model_id: string; parameters: Record<string, unknown> }
    expect(posted?.url).toBe(`${URL}/api/v1/deployments`)
    expect(sent).toEqual({ model_id: 'Qwen/Qwen3-8B', parameters: { port: 8199 } })
    expect(textOf(answered)).toContain('a1b2c3d4')
  })

  test('uniform_deploy acknowledges remote code when it is allowed', async () => {
    const { kit } = await load()
    const asked = platform(kit.on, { '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) } })

    await kit.$.session.start()
    await kit.$.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: 'Qwen/Qwen3-8B', trust_remote_code: true })

    const sent = JSON.parse(asked.find(one => one.method === 'POST')?.body ?? '{}') as {
      parameters: Record<string, unknown>
    }
    expect(sent.parameters).toEqual({ trust_remote_code: true, remote_code_acknowledged: true })
  })

  test('a blank model_id is refused before the platform is asked', async () => {
    const { kit } = await load()
    const asked = platform(kit.on, {})

    await kit.$.session.start()
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: '  ' })

    expect(answered.deny).toContain('model_id')
    expect(asked).toEqual([])
  })

  test("a tool carries the platform's own words when it refuses", async () => {
    const { kit } = await load()
    platform(kit.on, { '/api/v1/deployments/no-such-id': { status: 404, body: '{"detail":"deployment not found"}' } })

    await kit.$.session.start()
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_status', deployment_id: 'no-such-id' })

    expect(answered.deny).toBe('deployment not found')
  })

  test('a tool says so when the platform is not there', async () => {
    const { kit } = await load()
    kit.on('http.fetch', () => ({ deny: 'connect ECONNREFUSED 127.0.0.1:18180' }))

    await kit.$.session.start()
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_list' })

    expect(answered.deny).toContain(URL)
    expect(answered.deny).toContain('ECONNREFUSED')
  })

  test('uniform_status describes one deployment', async () => {
    const { kit } = await load()
    platform(kit.on, {
      '/api/v1/deployments/a1b2c3d4': {
        status: 200,
        body: JSON.stringify({ ...DEPLOYMENT, status: 'failed', error_message: 'out of memory' }),
      },
    })

    await kit.$.session.start()
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_status', deployment_id: 'a1b2c3d4' })

    expect(textOf(answered)).toContain('status: failed')
    expect(textOf(answered)).toContain('error: out of memory')
  })

  test('uniform_logs reads the tail it was asked for, within bounds', async () => {
    const { kit } = await load()
    const asked = platform(kit.on, {
      '/api/v1/deployments/a1b2c3d4/logs?tail=50': { status: 200, body: '{"logs":"line one\\nline two"}' },
      '/api/v1/deployments/a1b2c3d4/logs?tail=2000': { status: 200, body: '{"logs":""}' },
    })

    await kit.$.session.start()
    const fifty = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_logs', deployment_id: 'a1b2c3d4', tail: 50 })
    const many = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_logs', deployment_id: 'a1b2c3d4', tail: 99_999 })

    expect(textOf(fifty)).toContain('line one')
    expect(asked.map(one => one.url)).toContain(`${URL}/api/v1/deployments/a1b2c3d4/logs?tail=2000`)
    expect(textOf(many)).toBe('No log lines for a1b2c3d4 yet.')
  })

  test('uniform_metrics reports what the platform sampled', async () => {
    const { kit } = await load()
    platform(kit.on, { '/api/v1/system/metrics': { status: 200, body: '{"gpu":{"name":"NVIDIA GB10"}}' } })

    await kit.$.session.start()
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_metrics' })

    expect(textOf(answered)).toContain('NVIDIA GB10')
  })

  test('uniform_stop stops the deployment the session is watching', async () => {
    const { kit } = await load()
    const asked = platform(kit.on, {
      '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) },
      '/api/v1/deployments/a1b2c3d4/stop': { status: 200, body: JSON.stringify({ ...DEPLOYMENT, status: 'stopping' }) },
    })

    await kit.$.session.start()
    await kit.$.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: 'Qwen/Qwen3-8B' })
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_stop' })

    expect(asked.map(one => one.url)).toContain(`${URL}/api/v1/deployments/a1b2c3d4/stop`)
    expect(textOf(answered)).toContain('stopping')
  })

  test('a tool that was given no deployment says which one to name', async () => {
    const { kit } = await load()
    platform(kit.on, { '/api/v1/deployments?limit=50': listing() })

    await kit.$.session.start()
    const answered = await kit.$.tool.call({ tool: 'mcp__uniform__uniform_status' })

    expect(answered.deny).toContain('deployment_id')
  })
})

describe('/uniform', () => {
  test('lists the deployments as text, since no pane is placed', async () => {
    const { kit } = await load()
    platform(kit.on, {
      '/api/v1/deployments?limit=50': listing(DEPLOYMENT, {
        ...DEPLOYMENT,
        id: 'e5f6a7b8',
        model_id: 'meta-llama/Llama-3.2-3B',
        status: 'running',
        progress: 1,
      }),
    })

    await kit.$.session.start()
    const answered = await kit.$.command.run({ command: 'uniform', args: '' })

    expect(answered.text).toContain('2 deployment(s), 1 moving')
    expect(answered.text).toContain('a1b2c3d4  Qwen/Qwen3-8B  loading the model 78%')
    expect(answered.text).toContain('e5f6a7b8  meta-llama/Llama-3.2-3B  running')
  })

  test('names the platform it could not reach', async () => {
    const { kit } = await load()
    kit.on('http.fetch', () => ({ deny: 'connect ECONNREFUSED' }))

    await kit.$.session.start()
    const answered = await kit.$.command.run({ command: 'uniform', args: '' })

    expect(answered.text).toContain(`no platform at ${URL}`)
  })
})

describe('the poll loop', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('re-reads quickly while a deployment moves, slowly once it serves', async () => {
    vi.useFakeTimers()
    const { kit } = await load()
    let status = 'loading_model'
    const reads: number[] = []
    kit.on('http.fetch', () => {
      reads.push(Date.now())
      return {
        value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items: [{ ...DEPLOYMENT, status }] }) },
      }
    })

    await kit.$.session.start()
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(reads).toHaveLength(2)

    status = 'running'
    await vi.advanceTimersByTimeAsync(3_000)
    expect(reads).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(reads).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reads).toHaveLength(4)
  })
})

describe('the band above the prompt', () => {
  const band = { component: 'AbovePrompt' as const, props: { bodyColumns: 120 } }

  test('yields when nothing is deployed', async () => {
    const { kit } = await load()
    platform(kit.on, { '/api/v1/deployments?limit=50': listing() })

    await kit.$.session.start()
    await kit.$.command.run({ command: 'uniform', args: '' })
    const ui = await kit.$.ui.mount(band)

    expect(await ui.tree()).toBeNull()
  })

  test('stays out of the way of a session that never used an unreachable platform', async () => {
    const { kit } = await load()
    kit.on('http.fetch', () => ({ deny: 'connect ECONNREFUSED' }))

    await kit.$.session.start()
    await kit.$.command.run({ command: 'uniform', args: '' })
    const ui = await kit.$.ui.mount(band)

    expect(await ui.tree()).toBeNull()
  })

  test('tracks a deployment the session started, with its progress', async () => {
    const { kit } = await load()
    platform(kit.on, {
      '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) },
      '/api/v1/deployments?limit=50': listing(DEPLOYMENT),
    })

    await kit.$.session.start()
    await kit.$.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: 'Qwen/Qwen3-8B' })
    const text = await (await kit.$.ui.mount(band)).text()

    expect(text).toContain('uniform*')
    expect(text).toContain('Qwen/Qwen3-8B')
    expect(text).toContain('loading the model')
    expect(text).toContain('████████░░ 78%')
  })

  test('drops the progress bar on a narrow band', async () => {
    const { kit } = await load()
    platform(kit.on, { '/api/v1/deployments?limit=50': listing(DEPLOYMENT) })

    await kit.$.session.start()
    await kit.$.command.run({ command: 'uniform', args: '' })
    const text = await (await kit.$.ui.mount({ ...band, props: { bodyColumns: 60 } })).text()

    expect(text).toContain('78%')
    expect(text).not.toContain('█')
  })

  test("shows the session's failed deployment until it is dismissed", async () => {
    const { kit } = await load()
    const failed = { ...DEPLOYMENT, status: 'failed', progress: 0.4, error_message: 'CUDA out of memory' }
    platform(kit.on, {
      '/api/v1/deployments': { status: 201, body: JSON.stringify(DEPLOYMENT) },
      '/api/v1/deployments?limit=50': listing(failed),
    })

    await kit.$.session.start()
    await kit.$.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: 'Qwen/Qwen3-8B' })
    const ui = await kit.$.ui.mount(band)

    expect(await ui.text()).toContain('CUDA out of memory')
    await (await ui.find({ type: 'Button' }))?.press()
    expect(await ui.tree()).toBeNull()
  })

  test('says so once a platform the session used stops answering', async () => {
    const { kit } = await load()
    let isUp = true
    kit.on('http.fetch', (_$, e: { init?: { method?: string } }) => {
      if (!isUp) return { deny: 'connect ECONNREFUSED' }
      const body = e.init?.method === 'POST' ? JSON.stringify(DEPLOYMENT) : JSON.stringify({ items: [DEPLOYMENT] })
      return { value: { status: 200, ok: true, headers: {}, text: body } }
    })

    await kit.$.session.start()
    await kit.$.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: 'Qwen/Qwen3-8B' })
    isUp = false
    await kit.$.command.run({ command: 'uniform', args: '' })

    expect(await (await kit.$.ui.mount(band)).text()).toContain(`no platform at ${URL}`)
  })
})
