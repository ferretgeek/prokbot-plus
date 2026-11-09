#!/usr/bin/env node
// Command-line access to the Host admin API, for scripted or AI-driven deployments.
// Usage: node tools/host-admin.mjs <command> [options]   (run `help` for details)
// Secrets are read from environment variables or files, never from arguments.
import { readFileSync } from 'node:fs';

const HELP = `用法：node tools/host-admin.mjs <命令> [选项]

环境变量
  GROKBOT_URL              Host 地址，默认 http://127.0.0.1:18080
  GROKBOT_ADMIN_PASSWORD   管理员密码（或用 --password-file 指定文件）
  GROKBOT_SETUP_KEY        初始化码（setup 命令；或用 --setup-key-file）
  MODEL_API_KEY            模型 API Key（model-set / model-catalog；为空时沿用 Host 已保存的 Key）

命令
  session                  查询是否已初始化
  setup                    用初始化码设置管理员密码（密码 12–128 位，取自 GROKBOT_ADMIN_PASSWORD）
  status                   Host、对话核心、模型、设备摘要
  model-show               当前模型配置（不含 Key）
  model-catalog            列出接口提供的模型、思考强度与上下文长度
  model-set                测试并保存模型配置，等待 Host 应用
  pair                     生成一次性配对码（6 位，5 分钟有效）

model-catalog / model-set 选项
  --format <openai|openai-responses|anthropic>   接口格式（默认沿用当前配置）
  --base-url <URL>        OpenAI 两种格式通常以 /v1 结尾；Anthropic 填根地址
  --model <ID>            模型 ID（model-set 必填）
  --effort <级别>         default、none、minimal、low、medium、high、xhigh、max（须为模型支持的值）
  --efforts <a,b,c>       手动指定模型支持的思考强度（接口不提供时使用）
  --context <tokens>      上下文长度，0 表示使用默认
  --test-only             只测试，不保存`;

const argv = process.argv.slice(2);
const command = argv[0];
const options = {};
for (let index = 1; index < argv.length; index++) {
  const flag = argv[index];
  const name = flag.startsWith('--') ? flag.slice(2) : null;
  if (name === 'test-only') options.testOnly = true;
  else if (name && index + 1 < argv.length) options[name] = argv[++index];
  else { console.error(`错误：无法识别的参数 ${flag}`); process.exit(1); }
}
const origin = (process.env.GROKBOT_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
let cookie = '';

class CliError extends Error {}
function fail(message) { throw new CliError(message); }
function secret(envName, fileOption) {
  if (options[fileOption]) return readFileSync(options[fileOption], 'utf8').trim();
  return (process.env[envName] || '').trim();
}
// Mutations need the CSRF header; Origin is omitted so access through a tunnel or another address still works.
async function api(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(origin + path, { method, redirect: 'manual', signal: AbortSignal.timeout(180_000),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-grokbot-csrf': '1' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  } catch (error) { fail(`无法连接 ${origin}：${error.cause?.code ?? error.message}`); }
  const set = response.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map(value => value.split(';')[0]).join('; ');
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) fail(`${method} ${path} → HTTP ${response.status} ${typeof data === 'object' ? data.error ?? JSON.stringify(data) : String(data).slice(0, 300)}`);
  return data;
}
async function login() {
  const password = secret('GROKBOT_ADMIN_PASSWORD', 'password-file');
  if (!password) fail('请设置 GROKBOT_ADMIN_PASSWORD 或使用 --password-file');
  await api('/admin/api/login', 'POST', { password });
}
const print = value => console.log(JSON.stringify(value, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function modelConfig({ listing = false } = {}) {
  const current = await api('/admin/api/model');
  const apiFormat = options.format ?? current.apiFormat;
  const baseUrl = options['base-url'] ?? current.baseUrl;
  // Listing does not depend on the model, but the Host validates a complete configuration.
  const model = options.model || current.model || (listing ? 'model-list' : '');
  if (!baseUrl) fail('请用 --base-url 指定模型接口地址');
  if (!model) fail('请用 --model 指定模型 ID');
  return { apiFormat, baseUrl, model, apiKey: secret('MODEL_API_KEY', 'api-key-file'), jevApiKey: '' };
}
async function efforts(config) {
  if (options.efforts) return { efforts: options.efforts.split(',').map(item => item.trim()).filter(Boolean) };
  try {
    const { models } = await api('/admin/api/model/catalog', 'POST', config);
    const entry = models.find(item => item.id === config.model);
    if (entry) return { efforts: entry.efforts, contextWindowTokens: entry.contextWindowTokens, source: entry.source };
    console.error(`提示：模型列表中没有 ${config.model}，改用内置参考值`);
  } catch (error) { console.error(`提示：读取模型列表失败（${error.message}），改用内置参考值`); }
  const { effortLevels } = await import('../runtime/model-policy.mjs');
  return { efforts: effortLevels(config.model), source: 'reference' };
}

async function main() {
switch (command) {
  case 'session':
    print(await api('/admin/api/session'));
    break;
  case 'setup': {
    const setupKey = secret('GROKBOT_SETUP_KEY', 'setup-key-file');
    const password = secret('GROKBOT_ADMIN_PASSWORD', 'password-file');
    if (!setupKey) fail('请设置 GROKBOT_SETUP_KEY（容器内 /data/setup-key 的内容）');
    if (password.length < 12 || password.length > 128) fail('GROKBOT_ADMIN_PASSWORD 需要 12–128 位');
    await api('/admin/api/setup', 'POST', { setupKey, password });
    console.log('管理员已设置');
    break;
  }
  case 'status': {
    await login();
    const status = await api('/admin/api/status');
    print({ publicUrl: status.publicUrl, hostConnected: status.host?.connected,
      model: { apiFormat: status.model.apiFormat, baseUrl: status.model.baseUrl, model: status.model.model,
        effort: status.model.policy?.effort, mode: status.model.policy?.mode, reload: status.model.reload?.status, hasApiKey: status.model.hasApiKey },
      devices: (status.devices ?? []).filter(device => !device.revokedAt).map(device => ({ name: device.name, platform: device.platform, kind: device.kind })),
      pendingPairingKeys: (status.pairingKeys ?? []).length });
    break;
  }
  case 'model-show':
    await login();
    print(await api('/admin/api/model'));
    break;
  case 'model-catalog': {
    await login();
    const { models } = await api('/admin/api/model/catalog', 'POST', await modelConfig({ listing: true }));
    for (const item of models) console.log(`${item.id}\t${item.efforts.join(',') || '-'}\t${item.contextWindowTokens ?? ''}`);
    break;
  }
  case 'model-set': {
    if (!options.model) fail('请用 --model 指定模型 ID');
    await login();
    const base = await modelConfig();
    const levels = await efforts(base);
    const effort = options.effort ?? 'default';
    if (effort !== 'default' && !levels.efforts.includes(effort))
      fail(`${base.model} 支持的思考强度为 [${levels.efforts.join(', ') || '无'}]；可用 --efforts 手动指定`);
    const contextWindowTokens = Number(options.context ?? levels.contextWindowTokens ?? 0);
    const config = { ...base, contextWindowTokens, policy: { mode: 'manual', effort, classifierModel: 'jev-latest',
      models: [{ id: base.model, efforts: levels.efforts, ...(contextWindowTokens ? { contextWindowTokens } : {}) }],
      routes: Object.fromEntries(['routine', 'reasoning', 'expert'].map(tier => [tier, { model: base.model, effort: 'auto' }])) } };
    console.log(`测试 ${config.apiFormat} ${config.baseUrl} ${config.model} effort=${effort}（可用：${levels.efforts.join(',') || '无'}）`);
    print(await api('/admin/api/model/test', 'POST', config));
    if (options.testOnly) break;
    await api('/admin/api/model', 'PUT', config);
    console.log('已保存，等待 Host 应用（正在运行的任务结束后生效）…');
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await api('/admin/api/status');
      if (status.model.reload?.status === 'applied' && status.host?.connected) return console.log('已应用');
      if (status.model.reload?.status === 'error') fail(`应用失败：${status.model.reload.message ?? '请查看 Host 日志'}`);
      await sleep(3000);
    }
    fail('3 分钟内未应用，请查看 Host 日志');
    break;
  }
  case 'pair': {
    await login();
    const pairing = await api('/admin/api/pairing-keys', 'POST', {});
    // Clients must enter the Host's public address, which may differ from the address used here.
    const { publicUrl } = await api('/admin/api/session');
    print({ ...pairing, hostUrl: publicUrl || origin });
    break;
  }
  case undefined: case 'help': case '--help': case '-h':
    console.log(HELP);
    break;
  default:
    fail(`未知命令 ${command}\n\n${HELP}`);
}
}

try { await main(); }
catch (error) {
  console.error(`错误：${error instanceof CliError ? error.message : error.stack ?? error}`);
  process.exitCode = 1;
}
