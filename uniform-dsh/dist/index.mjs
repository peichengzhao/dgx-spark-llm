// src/index.ts
import { fileURLToPath } from "node:url";
import { defineMod } from "@deepseek-ai/dsh-experimental-claude-code-mods";

// ../uniform/hooks/client.ts
var LIST_PATH = "/api/v1/deployments?limit=50";
async function listDeployments(send2, config2) {
  const body = await request(send2, config2, "GET", LIST_PATH);
  if (!body.isOk) return body;
  const items = body.value.items;
  if (!Array.isArray(items)) {
    return { isOk: false, status: null, reason: "the platform returned no deployment list" };
  }
  return { isOk: true, value: items };
}
async function getDeployment(send2, config2, id) {
  const body = await request(send2, config2, "GET", `/api/v1/deployments/${encodeURIComponent(id)}`);
  if (!body.isOk) return body;
  return { isOk: true, value: body.value };
}
async function createDeployment(send2, config2, payload) {
  const body = await request(send2, config2, "POST", "/api/v1/deployments", payload);
  if (!body.isOk) return body;
  return { isOk: true, value: body.value };
}
async function stopDeployment(send2, config2, id) {
  const body = await request(
    send2,
    config2,
    "POST",
    `/api/v1/deployments/${encodeURIComponent(id)}/stop`
  );
  if (!body.isOk) return body;
  return { isOk: true, value: body.value };
}
async function deploymentLogs(send2, config2, id, tail) {
  const body = await request(
    send2,
    config2,
    "GET",
    `/api/v1/deployments/${encodeURIComponent(id)}/logs?tail=${tail}`
  );
  if (!body.isOk) return body;
  const logs = body.value.logs;
  return { isOk: true, value: typeof logs === "string" ? logs : "" };
}
async function systemMetrics(send2, config2) {
  const body = await request(send2, config2, "GET", "/api/v1/system/metrics");
  if (!body.isOk) return body;
  return { isOk: true, value: body.value };
}
async function request(send2, config2, method, path, payload) {
  const headers = { Accept: "application/json" };
  if (config2.token !== "") headers["X-API-Key"] = config2.token;
  if (payload !== void 0) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await send2(`${config2.url}${path}`, {
      method,
      headers,
      body: payload === void 0 ? void 0 : JSON.stringify(payload)
    });
  } catch (error) {
    return { isOk: false, status: null, reason: `cannot reach ${config2.url}: ${describe(error)}` };
  }
  const parsed = parseJson(response.text);
  if (!response.ok) {
    return {
      isOk: false,
      status: response.status,
      reason: detailOf(parsed) ?? `the platform answered HTTP ${response.status}`
    };
  }
  if (parsed === void 0) {
    return { isOk: false, status: response.status, reason: "the platform sent no JSON body" };
  }
  return { isOk: true, value: parsed };
}
function detailOf(parsed) {
  if (typeof parsed !== "object" || parsed === null) return null;
  const detail = parsed.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return JSON.stringify(detail);
  return null;
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
var STATUS_LABELS = {
  queued: "queued",
  preflight: "checking the machine",
  downloading_model: "downloading weights",
  pulling_image: "pulling the image",
  starting_container: "starting the container",
  loading_model: "loading the model",
  health_checking: "health-checking",
  running: "running",
  stopping: "stopping",
  stopped: "stopped",
  failed: "failed",
  cancelled: "cancelled"
};
var TERMINAL = ["stopped", "failed", "cancelled"];
function isTerminal(status) {
  return TERMINAL.includes(status);
}

// src/register.ts
var PLUGIN = "uniform";
var COMMAND = "uniform";
var POLL_MS = 3e3;
var IDLE_POLL_MS = 3e4;
var LOG_TAIL = 200;
var LOG_TAIL_MAX = 2e3;
var DEFAULT_URL = "http://127.0.0.1:18180";
var BAR_CELLS = 10;
var platform = {
  ref: { plugin: PLUGIN, key: "platform" },
  initial: { url: "", isReachable: false, isTokenRefused: false }
};
var deployments = { ref: { plugin: PLUGIN, key: "deployments" }, initial: [] };
var watching = { ref: { plugin: PLUGIN, key: "watching" }, initial: null };
var config = { url: DEFAULT_URL, token: "" };
var latestRead = /* @__PURE__ */ new Map();
var reads = 0;
function register(on, options) {
  config = configFrom(options);
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "List the Uniform platform deployments"
    });
    await registerTools($);
    await write($, platform, { url: config.url, isReachable: false, isTokenRefused: false });
    startWatching($);
    return next(e);
  });
  on("session.end", async ($, e, next) => {
    latestRead.delete(await $.session.id());
    return next(e);
  });
  on("command.run", { command: COMMAND }, async ($) => {
    await poll($);
    const info = await read($, platform);
    if (!info.isReachable) {
      return { text: `Uniform: ${unreachableText(info)}. Set platform_url and api_token in the profile's cordis.patch.yml.` };
    }
    const list = await read($, deployments);
    if (list.length === 0) return { text: `Uniform (${config.url}): no deployments yet.` };
    const tracked = await read($, watching);
    const lines = list.map((one) => `${one.id === tracked ? "*" : " "} ${listLine(one)}`);
    return { text: [`Uniform (${config.url}): ${list.length} deployment(s), ${countMoving(list)} moving.`, ...lines].join("\n") };
  });
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const info = await read($, platform);
    const list = await read($, deployments);
    const tracked = await read($, watching);
    const drawn = band($.ui.resolve(e), info, list, tracked, $, bandWidth(e.props));
    if (drawn === null) return next(e);
    return drawn;
  });
  on("tool.call", { tool: `mcp__${PLUGIN}__uniform_list` }, async ($) => listTool($));
  on("tool.call", { tool: `mcp__${PLUGIN}__uniform_deploy` }, async ($, e) => deployTool($, e));
  on("tool.call", { tool: `mcp__${PLUGIN}__uniform_status` }, async ($, e) => statusTool($, e));
  on("tool.call", { tool: `mcp__${PLUGIN}__uniform_logs` }, async ($, e) => logsTool($, e));
  on("tool.call", { tool: `mcp__${PLUGIN}__uniform_metrics` }, async ($) => metricsTool($));
  on("tool.call", { tool: `mcp__${PLUGIN}__uniform_stop` }, async ($, e) => stopTool($, e));
}
async function poll($) {
  const session = await $.session.id();
  const mine = ++reads;
  latestRead.set(session, mine);
  const answered = await listDeployments(send($), config);
  if (latestRead.get(session) !== mine) return;
  if (!answered.isOk) {
    const refused = answered.status === 401 || answered.status === 403;
    await write($, platform, { url: config.url, isReachable: false, isTokenRefused: refused });
    return;
  }
  await write($, platform, { url: config.url, isReachable: true, isTokenRefused: false });
  await write($, deployments, answered.value);
}
function startWatching($) {
  const beat = async () => {
    try {
      await poll($);
    } finally {
      const list = await read($, deployments).catch(() => []);
      schedule($, list.some(isMoving) ? POLL_MS : IDLE_POLL_MS, beat);
    }
  };
  schedule($, POLL_MS, beat);
}
function schedule($, ms, fn) {
  try {
    $.clock.after(ms, fn);
  } catch {
  }
}
async function registerTools($) {
  await $.tool.register({
    name: "uniform_list",
    description: "List the model deployments the Uniform platform knows about, with each one's id, model, stage and progress.",
    inputSchema: { type: "object", properties: {} }
  });
  await $.tool.register({
    name: "uniform_deploy",
    description: "Deploy a model through the Uniform platform. Answers as soon as the platform queues it, which is well before the server is serving: follow it with uniform_status or uniform_logs. Only model_id is required; every other parameter keeps the platform's own default.",
    inputSchema: {
      type: "object",
      properties: {
        model_id: {
          type: "string",
          description: 'The model to deploy, such as "Qwen/Qwen3-8B": a Hugging Face or ModelScope repository id, or any id the platform can resolve.'
        },
        source: {
          type: "string",
          enum: ["huggingface", "modelscope"],
          description: "Where to fetch the weights from; defaults to huggingface."
        },
        local_model_path: {
          type: "string",
          description: "An absolute path to weights already on the machine, to deploy those instead of downloading them."
        },
        port: { type: "integer", description: "Host port for the API; default 8000." },
        image: { type: "string", description: "The inference container image to run." },
        max_model_len: {
          type: "integer",
          description: "The longest context the server will accept, in tokens."
        },
        gpu_memory_utilization: {
          type: "number",
          description: "The fraction of GPU memory the server may claim; default 0.9."
        },
        trust_remote_code: {
          type: "boolean",
          description: "Allow the model repository to run its own Python on this machine. Only for a repository the person trusts."
        }
      },
      required: ["model_id"]
    }
  });
  await $.tool.register({
    name: "uniform_status",
    description: "Report one deployment in detail: model, stage, progress, attempts and any error. Defaults to the deployment this session is watching, else the most recent one.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "Defaults to the current one." }
      }
    }
  });
  await $.tool.register({
    name: "uniform_logs",
    description: "Read the container log the platform kept for a deployment \u2014 where a download, a container start or a model load reports why it stalled or failed.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "Defaults to the current one." },
        tail: {
          type: "integer",
          description: `Lines to read; default ${LOG_TAIL}, at most ${LOG_TAIL_MAX}.`
        }
      }
    }
  });
  await $.tool.register({
    name: "uniform_metrics",
    description: "The machine's CPU, GPU, unified memory, disk and network, as the platform samples them.",
    inputSchema: { type: "object", properties: {} }
  });
  await $.tool.register({
    name: "uniform_stop",
    description: "Stop a deployment through the platform. Confirm with the person first unless they asked for this stop.",
    inputSchema: {
      type: "object",
      properties: {
        deployment_id: { type: "string", description: "Defaults to the current one." }
      }
    }
  });
}
async function listTool($) {
  const answered = await listDeployments(send($), config);
  if (!answered.isOk) return failed(answered.reason);
  if (answered.value.length === 0) return ok("No deployments.");
  return ok(answered.value.map(listLine).join("\n"));
}
async function deployTool($, input) {
  const modelId = input.model_id;
  if (typeof modelId !== "string" || modelId.trim() === "") {
    return failed('model_id is required, such as "Qwen/Qwen3-8B".');
  }
  const answered = await createDeployment(send($), config, deployPayload(input, modelId));
  if (!answered.isOk) return failed(answered.reason);
  await write($, watching, answered.value.id);
  await poll($);
  return ok(
    `Queued ${nameOf(answered.value)} as deployment ${answered.value.id}. Follow it with uniform_status or uniform_logs; the band above the prompt tracks it.`
  );
}
async function statusTool($, input) {
  const target = await resolveTarget($, input.deployment_id);
  if (!target.isOk) return failed(target.reason);
  const answered = await getDeployment(send($), config, target.value);
  if (!answered.isOk) return failed(answered.reason);
  return ok(describeDeployment(answered.value));
}
async function logsTool($, input) {
  const target = await resolveTarget($, input.deployment_id);
  if (!target.isOk) return failed(target.reason);
  const asked = typeof input.tail === "number" ? Math.trunc(input.tail) : LOG_TAIL;
  const tail = Math.min(Math.max(asked, 1), LOG_TAIL_MAX);
  const answered = await deploymentLogs(send($), config, target.value, tail);
  if (!answered.isOk) return failed(answered.reason);
  if (answered.value.trim() === "") return ok(`No log lines for ${target.value} yet.`);
  return ok(answered.value);
}
async function metricsTool($) {
  const answered = await systemMetrics(send($), config);
  if (!answered.isOk) return failed(answered.reason);
  return ok(JSON.stringify(answered.value, null, 2));
}
async function stopTool($, input) {
  const target = await resolveTarget($, input.deployment_id);
  if (!target.isOk) return failed(target.reason);
  const answered = await stopDeployment(send($), config, target.value);
  if (!answered.isOk) return failed(answered.reason);
  await write($, watching, answered.value.id);
  await poll($);
  return ok(`${nameOf(answered.value)} (${answered.value.id}) is ${labelOf(answered.value)}.`);
}
async function resolveTarget($, named) {
  if (typeof named === "string" && named.trim() !== "") {
    return { isOk: true, value: named.trim() };
  }
  const tracked = await read($, watching);
  if (tracked !== null) return { isOk: true, value: tracked };
  const known = (await read($, deployments))[0];
  if (known !== void 0) return { isOk: true, value: known.id };
  const answered = await listDeployments(send($), config);
  if (answered.isOk) {
    const newest = answered.value[0];
    if (newest !== void 0) return { isOk: true, value: newest.id };
  }
  return { isOk: false, status: null, reason: "no deployment to act on; pass deployment_id." };
}
function band(ui, info, list, tracked, $, columns) {
  const { Box, Text, Button } = ui;
  if (!info.isReachable) {
    if (tracked === null || info.url === "") return null;
    return Box({
      flexDirection: "row",
      paddingX: 1,
      children: [Text({ color: "red", bold: true, children: PLUGIN }), Text({ children: `  ${unreachableText(info)}` })]
    });
  }
  const shown = [...list].filter((one) => !isTerminal(one.status) || one.id === tracked && one.status === "failed").sort((a, b) => Number(b.id === tracked) - Number(a.id === tracked));
  if (shown.length === 0) return null;
  const rows = shown.map((one) => {
    const parts = [
      Text({ color: "cyan", bold: true, children: `${PLUGIN}${one.id === tracked ? "*" : ""}` }),
      Text({ children: `  ${nameOf(one)}  ` }),
      Text({ color: colorOf(one), children: labelOf(one) })
    ];
    if (isMoving(one)) {
      if (columns >= 80) parts.push(Text({ color: colorOf(one), children: `  ${bar(one.progress)}` }));
      parts.push(Text({ dimColor: true, children: ` ${percentOf(one)}%` }));
    }
    if (one.status === "failed") {
      if (one.error_message !== null) parts.push(Text({ dimColor: true, children: `  ${one.error_message}` }));
      parts.push(
        Button({
          label: "Dismiss",
          onPress: async () => {
            if (await read($, watching) === one.id) await write($, watching, null);
          }
        })
      );
    }
    return Box({ flexDirection: "row", children: parts });
  });
  return Box({ flexDirection: "column", paddingX: 1, children: rows });
}
function bandWidth(props) {
  return typeof props.bodyColumns === "number" ? props.bodyColumns : 120;
}
function bar(progress) {
  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round(progress * BAR_CELLS)));
  return "\u2588".repeat(filled) + "\u2591".repeat(BAR_CELLS - filled);
}
function colorOf(one) {
  if (one.status === "running") return "green";
  if (one.status === "failed") return "red";
  if (isTerminal(one.status)) return "gray";
  return "yellow";
}
function ok(text) {
  return { result: text };
}
function failed(reason) {
  return { deny: reason };
}
async function read($, slot) {
  const { value } = await $.state.get(slot.ref);
  return value === void 0 ? slot.initial : value;
}
async function write($, slot, value) {
  const { value: held } = await $.state.get(slot.ref);
  if (held !== void 0 && JSON.stringify(held) === JSON.stringify(value)) return;
  await $.state.set(slot.ref, value);
}
function configFrom(options) {
  const url = typeof options.platform_url === "string" ? options.platform_url.trim() : "";
  const token = typeof options.api_token === "string" ? options.api_token.trim() : "";
  return { url: (url === "" ? DEFAULT_URL : url).replace(/\/+$/, ""), token };
}
function send($) {
  return (url, init) => $.http.fetch(url, init);
}
function deployPayload(input, modelId) {
  const parameters = {};
  const carry = [
    "source",
    "local_model_path",
    "port",
    "image",
    "max_model_len",
    "gpu_memory_utilization",
    "trust_remote_code"
  ];
  for (const field of carry) {
    if (input[field] !== void 0) parameters[field] = input[field];
  }
  if (parameters.trust_remote_code === true) parameters.remote_code_acknowledged = true;
  return { model_id: modelId.trim(), parameters };
}
function isMoving(one) {
  return !isTerminal(one.status) && one.status !== "running";
}
function countMoving(list) {
  return list.filter(isMoving).length;
}
function nameOf(one) {
  return one.display_name ?? one.model_id;
}
function labelOf(one) {
  return STATUS_LABELS[one.status] ?? one.status;
}
function percentOf(one) {
  return Math.round(one.progress * 100);
}
function listLine(one) {
  const progress = isMoving(one) ? ` ${percentOf(one)}%` : "";
  return `${one.id}  ${nameOf(one)}  ${labelOf(one)}${progress}`;
}
function unreachableText(info) {
  if (info.isTokenRefused) return `the API token was refused by ${info.url}`;
  return `no platform at ${info.url}`;
}
function describeDeployment(one) {
  const lines = [
    `deployment: ${one.id}`,
    `model: ${nameOf(one)}`,
    `status: ${labelOf(one)} (${percentOf(one)}%)`
  ];
  if (one.error_message !== null) lines.push(`error: ${one.error_message}`);
  lines.push(`attempt: ${one.attempt}`, `created: ${one.created_at}`);
  return lines.join("\n");
}

// src/index.ts
var index_default = defineMod({
  name: PLUGIN,
  version: "0.1.0",
  root: fileURLToPath(new URL("..", import.meta.url)),
  userConfig: { platform_url: DEFAULT_URL, api_token: "" },
  register
});
export {
  index_default as default
};
