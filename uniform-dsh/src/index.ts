import { fileURLToPath } from 'node:url'

import { defineMod } from '@deepseek-ai/dsh-experimental-claude-code-mods'

import { DEFAULT_URL, PLUGIN, register } from './register'

export default defineMod({
  name: PLUGIN,
  version: '0.1.0',
  root: fileURLToPath(new URL('..', import.meta.url)),
  userConfig: { platform_url: DEFAULT_URL, api_token: '' },
  register,
})
