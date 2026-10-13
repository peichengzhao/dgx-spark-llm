import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createUniformServer, DEFAULT_URL, VERSION } from './server'

const USAGE = `uniform-mcp ${VERSION}: an MCP server (stdio) for a Uniform DGX Spark platform.

Environment:
  UNIFORM_URL        Base URL of the Uniform control service (default ${DEFAULT_URL})
  UNIFORM_API_TOKEN  The platform's API token, when it was started with one

An agent starts this program and speaks MCP over its stdin and stdout.
`

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stderr.write(USAGE)
  process.exit(0)
}
if (process.argv.includes('--version')) {
  process.stderr.write(`${VERSION}\n`)
  process.exit(0)
}

const server = createUniformServer({
  url: process.env.UNIFORM_URL,
  token: process.env.UNIFORM_API_TOKEN,
})

await server.connect(new StdioServerTransport())
