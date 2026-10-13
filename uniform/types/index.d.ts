// The shape of the Uniform control service this plugin talks to, and the
// values the plugin keeps in `$.state`. The manifest names this file as the
// plugin's types, so every `$.state` key the hooks module uses is held to the
// contract below.

/** The lifecycle stages of one deployment, as the platform's state machine spells them. */
export type DeploymentStatus =
  | 'queued'
  | 'preflight'
  | 'downloading_model'
  | 'pulling_image'
  | 'starting_container'
  | 'loading_model'
  | 'health_checking'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'cancelled'

/** One deployment, as `GET /api/v1/deployments` returns it. */
export type Deployment = {
  id: string
  model_id: string
  revision: string | null
  display_name: string | null
  status: DeploymentStatus
  progress: number
  error_code: string | null
  error_message: string | null
  attempt: number
  version: number
  created_at: string
}

/** Whether the configured platform answered the last poll, and what it is. */
export type PlatformInfo = {
  url: string
  isReachable: boolean
}

declare module 'claude-code' {
  interface PluginState {
    uniform: {
      platform: PlatformInfo
      deployments: Deployment[]
      /** The deployment id the session is watching, or `null` when it watches the whole list. */
      watching: string | null
    }
  }
}
