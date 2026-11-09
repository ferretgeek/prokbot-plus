import { parseModelPolicy, defaultPolicy, validatePolicy, effortLevels, EFFORTS } from '../runtime/model-policy.mjs';
import { createModelRouter } from '../runtime/model-router.mjs';
import { anthropicEndpoint, anthropicHeaders } from '../runtime/anthropic-messages.mjs';
import { API_FORMATS, createModelSession } from '../runtime/model-session.mjs';
import { recordUsage } from '../runtime/usage-ledger.mjs';
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { check } from "./security.mjs";
import { readJson, writePrivate } from "./storage.mjs";

const clean = (value, label, maximum = 2048) => {
  check(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= maximum &&
      !/[\r\n\0]/.test(value),
    400,
    `${label}不能为空，也不能包含换行`,
  );
  return value.trim();
};
export class Models {
  constructor(dataDir, { filename = join(dataDir, "model.env") } = {}) {
    this.filename = filename;
    this.dataDir = dataDir;
    this.tail = Promise.resolve();
  }
  async current() {
    const filename = this.filename;
    const source = await readFile(filename, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const values = Object.fromEntries(
      source
        .split(/\r?\n/)
        .filter((line) => line.includes("=") && !line.startsWith("#"))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    return {
      apiFormat: API_FORMATS.includes(values.MODEL_API_FORMAT) ? values.MODEL_API_FORMAT : "openai",
      baseUrl: values.OPENAI_BASE_URL ?? "",
      model: values.OPENAI_MODEL ?? "",
      apiKey: values.OPENAI_API_KEY ?? "",
      contextWindowTokens: Number(values.OPENAI_CONTEXT_WINDOW_TOKENS ?? 0),
      policy: parseModelPolicy(values.GROKBOT_MODEL_POLICY, values.OPENAI_MODEL || undefined),
      jevApiKey: values.JEV_API_KEY || "",
    };
  }
  async publicConfig() {
    const { apiKey, jevApiKey, ...config } = await this.current();
    return {
      ...config,
      hasApiKey: Boolean(apiKey),
      hasJevApiKey: Boolean(jevApiKey),
      configured: Boolean(config.baseUrl && config.model && apiKey),
      reload: await this.reloadStatus(),
    };
  }
  async reloadStatus() {
    const request = await readJson(
      join(this.dataDir, "model-reload-request.json"),
      null,
    );
    const status = await readJson(
      join(this.dataDir, "model-reload-status.json"),
      null,
    );
    if (!request) return status ?? { status: "none" };
    if (status?.revision === request.revision) {
      const allowed = ["applied", "waiting", "error", "pending"];
      return {
        revision: status.revision,
        status: allowed.includes(status.status) ? status.status : "pending",
        updatedAt: status.updatedAt,
        message:
          status.status === "error"
            ? "Host 未能应用配置，请检查服务日志"
            : undefined,
      };
    }
    return {
      revision: request.revision,
      status: "pending",
      updatedAt: request.requestedAt,
    };
  }
  async validated(input) {
    const previous = await this.current();
    const apiFormat = input.apiFormat ?? previous.apiFormat;
    check(API_FORMATS.includes(apiFormat), 400, "接口格式无效");
    const baseUrl = clean(input.baseUrl, "Base URL");
    let url;
    try {
      url = new URL(baseUrl);
    } catch {
      check(false, 400, "Base URL 格式不正确");
    }
    check(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      400,
      "Base URL 需要 HTTP(S) 地址，不能包含凭证或查询参数",
    );
    const model = clean(input.model, "模型名称", 256);
    const apiKey = clean(input.apiKey || previous.apiKey, "API Key", 8192);
    const contextWindowTokens = Number(
      input.contextWindowTokens ?? previous.contextWindowTokens ?? 0,
    );
    check(
      Number.isSafeInteger(contextWindowTokens) &&
        contextWindowTokens >= 0 &&
        contextWindowTokens <= 100_000_000,
      400,
      "上下文长度应为 0–100000000 的整数",
    );
    let policy;
    try { policy = validatePolicy(input.policy ?? (previous.model === model ? previous.policy : defaultPolicy(model)), model); }
    catch (error) { check(false, 400, error.message); }
    const jevApiKey = input.jevApiKey ? clean(input.jevApiKey, "Jev API Key", 8192) : previous.jevApiKey;
    check(policy.mode !== 'adaptive' || jevApiKey, 400, '请填写 Jev API Key');
    return {
      policy, jevApiKey, apiFormat,
      baseUrl: url.href.replace(/\/$/, ""),
      model,
      apiKey,
      contextWindowTokens,
    };
  }
  save(input) {
    const pending = this.tail.then(async () => {
      const config = await this.validated(input);
      await writePrivate(
        this.filename,
        [
          `MODEL_API_FORMAT=${config.apiFormat}`,
          `OPENAI_BASE_URL=${config.baseUrl}`,
          `OPENAI_API_KEY=${config.apiKey}`,
          `OPENAI_MODEL=${config.model}`,
          `OPENAI_CONTEXT_WINDOW_TOKENS=${config.contextWindowTokens}`,
          `GROKBOT_MODEL_POLICY=${JSON.stringify(config.policy)}`,
          `JEV_API_KEY=${config.jevApiKey}`,
          "",
        ].join("\n"),
      );
      const request = {
        revision: randomUUID(),
        requestedAt: new Date().toISOString(),
      };
      await writePrivate(
        join(this.dataDir, "model-reload-request.json"),
        `${JSON.stringify(request)}\n`,
      );
      return this.publicConfig();
    });
    this.tail = pending.catch(() => {});
    return pending;
  }
  async catalog(input) {
    const previous = await this.current();
    const config = await this.validated({ ...previous, ...input });
    let response;
    const anthropic = config.apiFormat === 'anthropic';
    try { response = await fetch(anthropic ? anthropicEndpoint(config.baseUrl, 'models') : `${config.baseUrl}/models`, { redirect: 'error',
      headers: anthropic ? anthropicHeaders(config.apiKey) : { authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(15000) }); }
    catch { check(false, 502, '无法读取模型列表'); }
    check(response.ok, 502, `Model catalog HTTP ${response.status}`);
    const body = await response.json();
    check(Array.isArray(body.data), 502, '模型列表格式不兼容');
    return { models: body.data.filter(item => typeof item.id === 'string').slice(0, 200).map(item => {
      const supplied = item.supported_reasoning_efforts ?? item.supported_efforts ?? item.reasoning_effort?.values ?? item.capabilities?.reasoning_efforts;
      const levels = Array.isArray(supplied) ? EFFORTS.filter(level => supplied.includes(level)) : null;
      // Context capacity as reported by OpenAI-style and Anthropic catalogs.
      const capacity = [item.context_window, item.max_input_tokens, item.context_length].find(value => Number.isSafeInteger(value) && value > 0 && value <= 100_000_000);
      return { id: item.id, efforts: levels ?? effortLevels(item.id), source: levels ? 'provider' : effortLevels(item.id).length ? 'reference' : 'manual',
        ...(capacity ? { contextWindowTokens: capacity } : {}) };
    }) };
  }
  async classify(input) {
    const config = await this.validated(input);
    check(config.jevApiKey, 400, '请填写 Jev API Key');
    const route = createModelRouter({ ...config, policy: { ...config.policy, mode: 'adaptive' }, usageDirectory: join(this.dataDir, 'usage'), routingDirectory: join(this.dataDir, 'routing'), routingSource: 'test' });
    const decision = await route({ messages: [{ role: 'user', content: clean(input.task, '任务', 10000) }] });
    const { requestOptions, ...result } = decision;
    return result;
  }
  /** One real streamed turn through the production session, in the selected API format. */
  async test(input) {
    const config = await this.validated(input);
    let usage;
    const session = createModelSession({ ...config, onUsage: async value => { usage = value; },
      selectRequest: async () => ({ model: config.model, effort: config.policy.effort }) });
    const result = session.getExecutor([{ role: 'user', content: 'Reply with OK.' }])
      .stream({ signal: AbortSignal.timeout(120_000) }, 'model-test', []);
    let text = '';
    try {
      for await (const part of result.fullStream) if (part.type === 'text-delta') text += part.textDelta;
      await result.response;
    } catch (error) {
      check(false, 502, error.name === 'TimeoutError' || error.name === 'AbortError' ? '模型服务连接超时，请检查地址与网络'
        : error.status ? `模型服务返回 HTTP ${error.status}：${String(error.message).slice(0, 300)}` : `模型请求失败：${String(error.message).slice(0, 300)}`);
    } finally {
      if (usage) await recordUsage(join(this.dataDir, 'usage'), { ...usage, kind: 'test' }).catch(() => {});
    }
    check(text.trim(), 502, '模型没有返回文字内容');
    return { ok: true, model: config.model, message: "模型接口已完成真实请求" };
  }
}
