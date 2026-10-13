# Uniform DGX Spark — DeepSeek Harness 插件

在 DeepSeek Harness（桌面端、Web 或 CLI）的会话里驱动一个 Uniform DGX Spark
平台：部署模型、在提示框上方看部署进度、读容器日志、看 GPU 指标。

它与 [`../uniform`](../uniform) 里的 Claude Code 插件是同一个远程客户端，共用同一份
REST 客户端 [`client.ts`](../uniform/hooks/client.ts)，只是换了宿主：DeepSeek
Harness 通过实验性的
[Claude Code mods 桥接](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/claude-code-mods)
运行它。插件只通过平台的 REST API 工作，不启动平台，也不碰 Docker 或模型缓存。

## 前提

- DeepSeek Harness **0.2.1-alpha.1 或更新**（桥接从这个版本开始提供）。
- 一个已经在运行的 Uniform 平台，默认地址 `http://127.0.0.1:18180`。

## 安装到桌面端

桥接的依赖锁定到具体的 DeepSeek Harness 版本，所以下面的 `<版本>` 要换成你桌面端
的版本号（在“关于”里看，例如 `0.2.1-alpha.2`）。

1. **打包本插件**（`dist/` 已构建好并提交，不需要先安装依赖）：

   ```bash
   cd uniform-dsh
   npm pack            # 生成 uniform-dsh-0.1.0.tgz
   ```

2. 打开一次桌面端以初始化它的 profile，然后**完全退出**桌面端。

3. 用**桌面端自带的** `dsh` 命令安装桥接、Web 横幅和本插件。它在桌面端安装目录的
   `resources/runtime/cli/bin/dsh`（Windows 为 `dsh.cmd`）：

   ```bash
   dsh plugin --profile desktop add \
     @deepseek-ai/dsh-experimental-claude-code-mods@<版本> \
     @deepseek-ai/dsh-experimental-client-ui-claude-code-mods@<版本>
   dsh plugin --profile desktop add /绝对路径/uniform-dsh-0.1.0.tgz
   ```

   前两个包会提示 “declares no dsh.bundle — installed as a plain dependency”，这是
   正常的：挂载它们的配置行由本插件的 [`cordis.patch.yml`](cordis.patch.yml) 提供。

4. 重新打开桌面端，对它说：

   ```
   在 spark 上部署 Qwen/Qwen3-8B
   ```

卸载：`dsh plugin --profile desktop remove uniform-dsh`。

用 npm 装的 `dsh`（Web 或 CLI）同理，把 `--profile desktop` 换成你启动的 profile，
例如 `web`。

## 配置

两个选项，默认值见 [`cordis.patch.yml`](cordis.patch.yml)：

| 选项 | 默认 | 含义 |
| --- | --- | --- |
| `platform_url` | `http://127.0.0.1:18180` | Uniform 控制服务的地址；平台在别的机器上时，指向到它 `18180` 端口的 SSH 隧道。 |
| `api_token` | 空 | 平台的 `UNIFORM_API_TOKEN`，以 `X-API-Key` 发送。 |

要修改，在 `~/.dsh/profiles/desktop/cordis.patch.yml`（设置了 `DSH_HOME` 时在
`$DSH_HOME` 下）里覆盖 `uniform` 这一行，**两个键都要写**，因为后面的层会整体替换
一行的 `config`：

```yaml
- id: uniform
  config:
    platform_url: http://127.0.0.1:28180
    api_token: your-token
```

## 你会得到什么

**六个模型可调用的工具**，与 Claude Code 版完全一致：`uniform_list`、
`uniform_deploy`、`uniform_status`、`uniform_logs`、`uniform_metrics`、
`uniform_stop`（工具名为 `mcp__uniform__<name>`）。`uniform_status`、`uniform_logs`、
`uniform_stop` 不传 id 时，默认用本会话正在跟踪的部署，否则用最新的一个。

**提示框上方的横幅**，代替 Claude Code 版的状态栏和面板（桥接不放置面板，
`$.ui.status` 只写进宿主日志）：

```
uniform*  Qwen/Qwen3-8B  downloading weights  ████░░░░░░ 42%
uniform   meta-llama/Llama-3.2-3B  running
```

- 列出正在启动/停止的部署和正在服务的部署，`*` 是本会话跟踪的那个；
- 本会话的部署失败时，显示错误原因和一个 **Dismiss** 按钮；
- 平台连不上时，只在已经用过它的会话里提示，不打扰其他会话；
- 什么都没有时不占位置，把横幅让给其他 mod。

**`/uniform` 命令**，以文本列出平台上的部署。

## 与 Claude Code 版的差别

| Claude Code 版 | 本插件 |
| --- | --- |
| `/plugin install`，读 `plugin.json`、`hooks.json` | `dsh plugin add`；身份与默认配置在 `defineMod`，覆盖写在 `cordis.patch.yml` |
| TypeScript 钩子模块，由 Claude Code 直接加载 | 构建成一个 `dist/index.mjs`（桌面端只加载 JavaScript） |
| `atom` / `read` / `update`（`claude-code` 运行时导出） | 直接用 `$.state.get` / `$.state.set` |
| 状态栏一行 + `/uniform` 打开的面板 | 提示框上方的横幅 + `/uniform` 文本回复 |
| 一个进程一个会话，轮询状态放在模块变量里 | 一个进程多个会话：状态都在按会话的 `$.state`，轮询用 `$.clock` 定时器（随会话关闭）|
| 部署 `running` 时仍每 3 秒轮询 | `running` 视为已稳定，改为每 30 秒 |

## 安全

插件运行在 DeepSeek Harness 宿主进程内，不在 agent 的命令沙箱里；它只通过 `$.http`
访问配置的平台地址，但宿主不会替你限制这一点。只安装你信任的代码。

## 开发

```bash
cd uniform-dsh
npm install
npm run typecheck     # tsc，包括共用的 ../uniform/hooks/client.ts
npm test              # 通过桥接自带的 createModTestKit 运行全部钩子
npm run build         # 重新生成 dist/index.mjs —— 改了 src/ 或 client.ts 后要提交它
npm run check         # 以上全部，并确认 dist/ 与源码一致
```

测试用桥接自己的测试工具包加载插件，事件经过与 DeepSeek Harness 相同的钩子链；
平台由固定的 `$.http.fetch` 应答代替，所以不需要真实平台。

## 布局

```
uniform-dsh/
  package.json        dsh.bundle 声明、构建与测试脚本
  cordis.patch.yml    安装后插入 profile 的三行：桥接、Web 横幅、uniform
  src/index.ts        defineMod：插件名、版本、默认配置
  src/register.ts     钩子模块：工具、命令、横幅、轮询
  dist/index.mjs      构建产物，profile 实际加载的文件
  tests/              通过桥接测试工具包运行的测试
```
