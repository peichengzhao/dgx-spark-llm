# Uniform DGX Spark — MCP 服务器

一个 MCP（Model Context Protocol）服务器，让**任何支持 MCP 的 agent**——DeepSeek
Harness（桌面端 / Web / CLI）、Claude Code、Cursor、Codex 等——驱动一个 Uniform
DGX Spark 平台：部署模型、查看进度、读容器日志、看 GPU 指标。

它和 [`../uniform`](../uniform)（Claude Code 插件）、[`../uniform-dsh`](../uniform-dsh)
（DeepSeek Harness mod）提供同样的六个工具，共用同一份 REST 客户端
[`client.ts`](../uniform/hooks/client.ts)。服务器只通过平台的 REST API 工作，不启动
平台，也不碰 Docker 或模型缓存。

## 前提

- Node.js 20 或更新，`node` 在 agent 能找到的 PATH 上（或在配置里写 node 的绝对路径）。
- 一个已经在运行的 Uniform 平台，默认地址 `http://127.0.0.1:18180`。

`dist/index.mjs` 是打包好的单文件，**不需要 `npm install`**。下面的
`/绝对路径/uniform-mcp/dist/index.mjs` 换成你本机 clone 后的实际路径。

## 配置

两个环境变量：

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `UNIFORM_URL` | `http://127.0.0.1:18180` | Uniform 控制服务的地址；平台在别的机器上时，指向到它 `18180` 端口的 SSH 隧道。 |
| `UNIFORM_API_TOKEN` | 空 | 平台的 `UNIFORM_API_TOKEN`，以 `X-API-Key` 发送。 |

## 接入 DeepSeek Harness（含桌面端）

不需要安装任何插件包：DeepSeek Harness 自带 MCP 客户端
`@deepseek-ai/dsh-mcp-client`，加一行配置即可。

编辑 profile 的 `cordis.patch.yml`——桌面端是 `~/.dsh/profiles/desktop/cordis.patch.yml`
（设置了 `DSH_HOME` 时在 `$DSH_HOME` 下；`dsh web` 是 `profiles/web/`）。文件里可能已经
有模型设置等内容，**在末尾追加**，不要覆盖：

```yaml
- insert:
    - id: mcp-uniform
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: uniform
        transport: stdio
        command: node
        args: ['/绝对路径/uniform-mcp/dist/index.mjs']
        env:
          UNIFORM_URL: http://127.0.0.1:18180
          UNIFORM_API_TOKEN: ''
```

然后重启桌面端（或 `dsh web`）。工具会以 `mcp__uniform__uniform_deploy` 等名字出现。

注意：DeepSeek Harness 启动 MCP 子进程时会**清掉**名字里带 `TOKEN`、`KEY`、`SECRET`、
`PASSWORD` 的继承环境变量，所以 `UNIFORM_API_TOKEN` 必须像上面这样写在 `env` 里，
不能只在 shell 里 export。不想把 token 明文写进文件时，可以写
`UNIFORM_API_TOKEN: !!js process.env.UNIFORM_API_TOKEN`，在启动 DeepSeek Harness 的
环境里提供它（桌面端在 macOS/Linux 上会读取登录 shell 的环境）。

## 接入 Claude Code

```bash
claude mcp add uniform --scope user \
  --env UNIFORM_URL=http://127.0.0.1:18180 \
  --env UNIFORM_API_TOKEN= \
  -- node /绝对路径/uniform-mcp/dist/index.mjs
```

## 接入 Cursor

`~/.cursor/mcp.json`（全局）或项目里的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "uniform": {
      "command": "node",
      "args": ["/绝对路径/uniform-mcp/dist/index.mjs"],
      "env": {
        "UNIFORM_URL": "http://127.0.0.1:18180",
        "UNIFORM_API_TOKEN": ""
      }
    }
  }
}
```

## 接入 Codex

`~/.codex/config.toml`：

```toml
[mcp_servers.uniform]
command = "node"
args = ["/绝对路径/uniform-mcp/dist/index.mjs"]
env = { UNIFORM_URL = "http://127.0.0.1:18180", UNIFORM_API_TOKEN = "" }
```

## 工具

| 工具 | 作用 | 提示 |
| --- | --- | --- |
| `uniform_list` | 列出部署：id、模型、阶段、进度 | 只读 |
| `uniform_deploy` | 部署一个模型；平台排队后立即返回 | 只发调用方给出的参数，其余用平台默认 |
| `uniform_status` | 一个部署的详情，含错误 | 只读 |
| `uniform_logs` | 容器日志的末尾（默认 200 行，最多 2000） | 只读 |
| `uniform_metrics` | CPU、GPU、统一内存、磁盘、网络 | 只读 |
| `uniform_stop` | 停止一个部署 | 破坏性；工具描述要求模型先向你确认 |

`uniform_status`、`uniform_logs`、`uniform_stop` 不传 `deployment_id` 时，用本会话最近
部署或停止的那个，否则用平台上最新的一个。工具带有 MCP 的 `readOnlyHint` /
`destructiveHint` 标注，agent 可以据此决定哪些调用需要你批准。平台拒绝请求时，
模型看到的是平台自己的错误原文（`detail`）；连不上时看到地址和原因，例如
`cannot reach http://127.0.0.1:18180: fetch failed (ECONNREFUSED)`；单次请求最多等
30 秒。

试一句：

```
在 spark 上部署 Qwen/Qwen3-8B，然后告诉我它的状态
```

## 与另外两个版本的取舍

MCP 版没有 UI：没有状态栏、面板或横幅，进度要靠模型调用 `uniform_status`。换来的是
任何 agent 都能用、不依赖实验性接口、不需要和宿主版本对齐。想在 DeepSeek Harness
桌面端里看实时进度横幅，用 [`../uniform-dsh`](../uniform-dsh)。两者注册的工具名相同
（都是 `mcp__uniform__*`），在同一个 profile 里只启用其中一个。

## 开发

```bash
cd uniform-mcp
npm install
npm run typecheck   # tsc，包括共用的 ../uniform/hooks/client.ts
npm test            # 通过 MCP SDK 的客户端测试全部工具，并以 stdio 启动构建产物
npm run build       # 重新生成 dist/index.mjs —— 改了 src/ 或 client.ts 后要提交它
npm run check       # 以上全部，并确认 dist/ 与源码一致
```

手动调试可以用 MCP Inspector：
`npx @modelcontextprotocol/inspector node dist/index.mjs`。

## 布局

```
uniform-mcp/
  src/server.ts       六个工具：schema、标注、调用平台、组织回答
  src/index.ts        入口：读环境变量，以 stdio 提供服务
  dist/index.mjs      打包好的单文件（含 MCP SDK），agent 实际运行的文件
  tests/              SDK 客户端测试，以及对构建产物的 stdio 测试
```
