// The plugin's own tests, run by `claude plugin test <folder>` against the
// engine's test kit.
//
// Nothing beneath the plugins serves registration, the session's start, the
// pane or the platform, so each test stands the engine in for those with small
// hooks and then reads back what the plugin did with them.
//
// Covered here: the tools the plugin puts in front of the model, the command
// it adds, what the pane draws before any platform has answered, and what each
// tool answers once the platform does — the last with `$.http.fetch` answered
// from a fixed body, which is the only place the plugin reads the platform.
// What a running platform really says is exercised in a session, not here.

import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/** The platform the tests pretend to talk to, so the pane has a URL to name. */
const URL = 'http://spark.local:18180'

/** Every tool this plugin declares, spelled as the model calls them. */
const TOOLS = [
  'mcp__uniform__uniform_list',
  'mcp__uniform__uniform_deploy',
  'mcp__uniform__uniform_status',
  'mcp__uniform__uniform_logs',
  'mcp__uniform__uniform_metrics',
  'mcp__uniform__uniform_stop',
]

/** One deployment, as the platform's own schema spells it. */
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

/** What the engine is asked for, and what it answers. */
type Answered = { status: number; body: string }

/** The engine's own fetch, stood in for, recording every URL it was asked. */
function platform(on: On, answers: Record<string, Answered>): string[] {
  const asked: string[] = []

  on('http.fetch', (_$, e) => {
    asked.push(e.url)

    const answered = answers[e.url.replace(`${URL}`, '')]
    if (answered === undefined) return { value: { status: 404, ok: false, headers: {}, text: '{}' } }

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

/** The engine, stood in for wherever nothing beneath the plugins answers. */
function engine(on: On): void {
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__uniform__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('ui.status', () => ({ value: undefined }))
  mock.clock(on)
}

/** The text a tool result carries, whatever shape the plugin answered with. */
function textOf(answered: { deny?: string; result?: unknown; text?: string }): string {
  if (answered.deny !== undefined) return answered.deny
  if (answered.text !== undefined) return answered.text
  if (typeof answered.result === 'string') return answered.result

  return ''
}

test('registers the tools the model can call', async ($, on) => {
  const tools: string[] = []

  on('tool.register', (_$, e) => {
    tools.push(`mcp__uniform__${e.name}`)

    return { value: { tool: `mcp__uniform__${e.name}` } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  mock.clock(on)

  await $.session.start({ cwd: '/tmp', source: 'startup' })

  for (const tool of TOOLS) {
    expect(tools).toContain(tool)
  }
})

test('registers the /uniform command', async ($, on) => {
  const commands: string[] = []

  on('tool.register', (_$, e) => ({ value: { tool: `mcp__uniform__${e.name}` } }))
  on('command.register', (_$, e) => {
    commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  mock.clock(on)

  await $.session.start({ cwd: '/tmp', source: 'startup' })

  expect(commands).toContain('uniform')
})

test(
  'the pane names the configured platform',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)

    await $.session.start({ cwd: '/tmp', source: 'startup' })

    const ui = await $.ui.mount({
      plugin: 'uniform',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'uniform-deployments',
      props: {},
    })

    expect(await ui.find({ type: 'Text', text: /spark\.local:18180/ })).toBeDefined()
  },
)

test('the pane falls back to the platform on this machine', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/tmp', source: 'startup' })

  const ui = await $.ui.mount({
    plugin: 'uniform',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'uniform-deployments',
    props: {},
  })

  expect(await ui.find({ type: 'Text', text: /127\.0\.0\.1:18180/ })).toBeDefined()
})

test('the pane draws on every surface that has one', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/tmp', source: 'startup' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'uniform',
      surface,
      component: 'Pane',
      requestId: 'uniform-deployments',
      props: {},
    })

    expect(await ui.find({ type: 'Text' })).toBeDefined()
  }
})

test(
  'uniform_list reads the platform and names what it holds',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    const asked = platform(on, {
      '/api/v1/deployments?limit=50': { status: 200, body: JSON.stringify({ items: [DEPLOYMENT], total: 1 }) },
    })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({ tool: 'mcp__uniform__uniform_list' })

    expect(asked).toContain(`${URL}/api/v1/deployments?limit=50`)
    expect(textOf(answered)).toContain('a1b2c3d4')
    expect(textOf(answered)).toContain('loading the model')
  },
)

test(
  'uniform_deploy carries only what the call passed',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    const posts: { method: string; url: string; body: string }[] = []

    on('http.fetch', (_$, e) => {
      posts.push({
        method: e.init?.method ?? 'GET',
        url: e.url,
        body: e.init?.body ?? '',
      })

      return {
        value: { status: 201, ok: true, headers: {}, text: JSON.stringify(DEPLOYMENT) },
      }
    })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({
      tool: 'mcp__uniform__uniform_deploy',
      model_id: 'Qwen/Qwen3-8B',
      port: 8199,
    })

    const posted = posts.find(one => one.method === 'POST')
    expect(posted).toBeDefined()
    const sent = JSON.parse(posted?.body ?? '{}') as {
      model_id: string
      parameters: Record<string, unknown>
    }

    expect(posted?.url).toBe(`${URL}/api/v1/deployments`)
    expect(sent.model_id).toBe('Qwen/Qwen3-8B')
    expect(sent.parameters.port).toBe(8199)
    // The fields the call did not name are absent, so the platform keeps its own.
    expect(Object.keys(sent.parameters)).toEqual(['port'])
    expect(textOf(answered)).toContain('a1b2c3d4')
  },
)

test(
  'uniform_deploy acknowledges remote code when it is allowed',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    const posts: string[] = []

    on('http.fetch', (_$, e) => {
      if ((e.init?.method ?? 'GET') === 'POST') posts.push(e.init?.body ?? '')

      return {
        value: { status: 201, ok: true, headers: {}, text: JSON.stringify(DEPLOYMENT) },
      }
    })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    await $.tool.call({
      tool: 'mcp__uniform__uniform_deploy',
      model_id: 'Qwen/Qwen3-8B',
      trust_remote_code: true,
    })

    const sent = JSON.parse(posts[0] ?? '{}') as { parameters: Record<string, unknown> }

    expect(sent.parameters.trust_remote_code).toBe(true)
    expect(sent.parameters.remote_code_acknowledged).toBe(true)
  },
)

test(
  "a tool carries the platform's own words when it refuses",
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    platform(on, { '/api/v1/deployments/no-such-id': { status: 404, body: '{"detail":"deployment not found"}' } })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({
      tool: 'mcp__uniform__uniform_status',
      deployment_id: 'no-such-id',
    })

    expect(answered.deny).toBe('deployment not found')
  },
)

test(
  'a tool says so when the platform is not there',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    // A transport that cannot reach the host at all: the fetch itself fails,
    // rather than the platform answering with a status.
    on('http.fetch', () => ({ deny: 'connect ECONNREFUSED 127.0.0.1:18180' }))

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({ tool: 'mcp__uniform__uniform_list' })

    expect(answered.deny).toContain(URL)
    expect(answered.deny).toContain('ECONNREFUSED')
  },
)

test(
  'uniform_logs reads the tail it was asked for',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    const asked = platform(on, {
      '/api/v1/deployments/a1b2c3d4/logs?tail=50': {
        status: 200,
        body: '{"logs":"line one\\nline two"}',
      },
    })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({
      tool: 'mcp__uniform__uniform_logs',
      deployment_id: 'a1b2c3d4',
      tail: 50,
    })

    expect(asked).toContain(`${URL}/api/v1/deployments/a1b2c3d4/logs?tail=50`)
    expect(textOf(answered)).toContain('line one')
  },
)

test(
  'uniform_metrics reports what the platform sampled',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    platform(on, {
      '/api/v1/system/metrics': { status: 200, body: '{"gpu":{"name":"NVIDIA GB10"}}' },
    })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({ tool: 'mcp__uniform__uniform_metrics' })

    expect(textOf(answered)).toContain('NVIDIA GB10')
  },
)

test(
  'uniform_stop stops the deployment the session is watching',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    const asked = platform(on, {
      '/api/v1/deployments': {
        status: 201,
        body: JSON.stringify(DEPLOYMENT),
      },
      '/api/v1/deployments/a1b2c3d4/stop': {
        status: 200,
        body: JSON.stringify({ ...DEPLOYMENT, status: 'stopping' }),
      },
    })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    await $.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: 'Qwen/Qwen3-8B' })
    const answered = await $.tool.call({ tool: 'mcp__uniform__uniform_stop' })

    expect(asked).toContain(`${URL}/api/v1/deployments/a1b2c3d4/stop`)
    expect(textOf(answered)).toContain('stopping')
  },
)

test(
  'a tool that was given no deployment says which one to name',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    platform(on, {
      '/api/v1/deployments?limit=50': { status: 200, body: '{"items":[],"total":0}' },
    })

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({ tool: 'mcp__uniform__uniform_status' })

    expect(answered.deny).toContain('deployment_id')
  },
)

test(
  'a deployment named nothing but a model is refused before the platform is asked',
  { options: { platform_url: URL } },
  async ($, on) => {
    engine(on)
    const asked = platform(on, {})

    await $.session.start({ cwd: '/tmp', source: 'startup' })
    const answered = await $.tool.call({ tool: 'mcp__uniform__uniform_deploy', model_id: '  ' })

    expect(answered.deny).toContain('model_id')
    expect(asked).toEqual([])
  },
)
