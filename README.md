# Uniform DGX Spark — Claude Code plugin

Drive a [Uniform DGX Spark](https://github.com/) platform from a Claude Code
session: deploy models, follow a deployment's progress in the status line, read
its container log, and watch the machine's GPU.

## What this is

The Uniform platform is a service that manages local vLLM deployments on an
NVIDIA DGX Spark — weights, containers, health checks, inference tests. This
plugin is a **remote client** for that platform: it talks to it over its REST
API and nothing else. It never touches Docker, the model cache or the worker,
so the platform keeps owning the rules about what a session may deploy and how.

The platform must already be running. This plugin does not start it.

## Install

```
/plugin install uniform --marketplace zhachar14h-cell/uniform-dgxspark-claude-plugin
```

Answer `y` to add the marketplace, then pick a scope (user scope installs it in
every session from then on). The plugin is active immediately — no restart.

## Setup

Two settings, both under `/config`:

| Setting | Default | What it is |
| --- | --- | --- |
| **Platform URL** | `http://127.0.0.1:18180` | Where the Uniform control service answers. |
| **API token** | *(empty)* | The platform's `UNIFORM_API_TOKEN`, when it was started with one. |

The default works when the platform runs on the same machine — start it with
`./scripts/run-local.sh` from the platform checkout. For a platform on another
machine, point **Platform URL** at an SSH tunnel to its `18180` port.

## What you get

**A status line entry** while any deployment is moving:

```
uniform: Qwen3-8B downloading weights 42%
```

It polls every 3 seconds while something is in flight and every 30 seconds once
everything has settled, and goes quiet when nothing is deployed.

**A pane**, opened with `/uniform`, listing the deployments the platform knows:

```
http://127.0.0.1:18180
* a1b2c3d4  Qwen/Qwen3-8B — loading the model 78%
  e5f6a7b8  meta-llama/Llama-3.2-3B — running
```

**Six tools** the model can call:

| Tool | What it does |
| --- | --- |
| `uniform_list` | The deployments, with id, model, stage and progress. |
| `uniform_deploy` | Deploy a model. Returns as soon as the platform queues it. |
| `uniform_status` | One deployment in detail, including any error. |
| `uniform_logs` | The container log — where a stalled download says why. |
| `uniform_metrics` | CPU, GPU, unified memory, disk and network. |
| `uniform_stop` | Stop a deployment. |

`uniform_status`, `uniform_logs` and `uniform_stop` default to the deployment
the session is watching, else the newest one, so "is it up yet?" needs no id.

## A session, start to finish

```
deploy Qwen/Qwen3-8B on the spark
```

The model calls `uniform_deploy`, then follows it with `uniform_status` while
the status line counts up. If the deployment fails, `uniform_logs` has the
container's own reason.

## Requirements

- A running Uniform DGX Spark platform (Python 3.12+, Docker, an NVIDIA DGX
  Spark or any machine the platform supports).
- Claude Code 2.1.296 or newer.

## Developing

`claude --plugin-dir ./uniform` loads the plugin from this folder for one
session, and an edit reloads it when the turn ends.

```
claude plugin validate . --strict   # manifests, and what the module hooks
claude plugin test ./uniform        # the plugin's own tests
```

The tests answer `$.http.fetch` from a fixed body, so they cover each tool's
request and what it does with the platform's answer — a 404 whose `detail` the
model reads, a listing, a deploy's body, a log tail — without a platform. What
a running platform really says is checked in a session, against one.

To type-check it, copy this build's API declarations beside the plugin as
`uniform/.claude-plugin/types/claude-code/index.d.ts` and run `tsc -p uniform`.

## Layout

```
.claude-plugin/marketplace.json   the marketplace listing this one plugin
uniform/
  .claude-plugin/plugin.json      the plugin's manifest and its two settings
  hooks/register.tsx              the hooks module: tools, command, pane, poll
  hooks/client.ts                 the platform's REST API, and its error shape
  types/index.d.ts                the contract for the values kept in $.state
  tests/uniform.test.ts           the tools, the command, the pane, the client
```
