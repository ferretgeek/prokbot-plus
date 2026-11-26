import { grokText } from './i18n.mjs';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createNativeComputer } from './native-computer.mjs';
import { startNativeProvider } from './native-provider.mjs';
import { createCodexBridge } from './codex-bridge.mjs';

// The 0.71.2 Windows daemon runs commands in Windows PowerShell without its own UTF-8 console
// option, so output in the OEM code page (for example Chinese text) is decoded as UTF-8 and garbled.
// 1.1.0 turns the option on in the daemon itself.
const UTF8_CONSOLE = { from: 'new e3(i,t,t,void 0,void 0,void 0,s)', to: 'new e3(i,t,t,void 0,void 0,!0    ,s)' };
const UTF8_BUILT_IN = '{keepBackgroundJobs:!0,powershellUtf8Console:!0,powershellUtf8ChildEnv:!0}';
export function loadLocalExecDaemon(file, platform = process.platform) {
  if (platform !== 'win32') return createRequire(import.meta.url)(file);
  const source = readFileSync(file, 'utf8');
  if (source.includes(UTF8_BUILT_IN)) return createRequire(import.meta.url)(file);
  if (!source.includes(UTF8_CONSOLE.from)) {
    console.warn('[local-exec] UTF-8 console option not found; command output keeps the system code page');
    return createRequire(import.meta.url)(file);
  }
  const daemon = new Module(file);
  daemon.filename = file;
  daemon.paths = Module._nodeModulePaths(path.dirname(file));
  daemon._compile(source.replace(UTF8_CONSOLE.from, UTF8_CONSOLE.to), file);
  return daemon.exports;
}

export function machineIdForPlatform(deviceId, platform = process.platform) {
  const prefix = platform === 'win32' ? 'win' : platform === 'linux' ? 'linux' : 'mac';
  return `${prefix}-${deviceId}`;
}

function sanitizeComputerLabel(value) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, ' ').trim()
    : '';
}

export function mergeSandMachines({ currentMachine, remotePayload } = {}) {
  const rawList = Array.isArray(remotePayload?.computers) ? remotePayload.computers : [];
  const normalized = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const label = sanitizeComputerLabel(item.label) || id;
    const platform = typeof item.platform === 'string' && item.platform.trim() ? item.platform.trim() : 'unknown';
    normalized.push({ id, label, connected: item.connected === true, platform });
  }
  const currentId = typeof currentMachine?.machineId === 'string' ? currentMachine.machineId : '';
  const remoteSelf = currentId ? normalized.find(item => item.id === currentId) : null;
  const machines = [];

  if (currentId) {
    const connected = Boolean(currentMachine.connected || remoteSelf?.connected);
    const label = sanitizeComputerLabel(currentMachine.label)
      || remoteSelf?.label
      || currentId;
    const permission = ['ask', 'never', 'always'].includes(currentMachine.localToolPermission)
      ? currentMachine.localToolPermission
      : 'ask';
    machines.push({
      machineId: currentId,
      name: label,
      label,
      platform: currentMachine.platform || remoteSelf?.platform || 'unknown',
      kind: 'desktop',
      isCurrent: true,
      connected,
      isOnline: connected,
      localToolPermission: permission,
    });
  }

  for (const item of normalized) {
    if (item.id === currentId) continue;
    machines.push({
      machineId: item.id,
      name: item.label,
      label: item.label,
      platform: item.platform,
      kind: 'desktop',
      isCurrent: false,
      connected: item.connected,
      isOnline: item.connected,
      localToolPermission: 'ask',
    });
  }

  return { machines, currentMachineRemoved: false };
}

export async function createLocalExec({ payload, profile, config, command, request, window }) {
  const original = loadLocalExecDaemon(path.join(payload, 'local-exec-daemon/main.cjs'));
  const directory = path.join(profile, 'local-exec');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = path.join(directory, 'workspace');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const settingsPath = path.join(directory, 'settings.json');
  const approvalsPath = path.join(directory, 'approvals.json');
  const retirementsPath = path.join(directory, 'retirements.json');
  const standingGrantsPath = path.join(directory, 'standing-grants.json');
  let native, codex, closed = false;
  // The Host derives the platform from this prefix; macOS keeps its original form.
  const machineId = machineIdForPlatform(config.deviceId);
  let permission = 'ask', customLabel = '', writes = Promise.resolve();
  try {
    const value = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (['ask', 'never', 'always'].includes(value.permission)) permission = value.permission;
    const loadedLabel = sanitizeComputerLabel(value.label);
    if (loadedLabel) customLabel = [...loadedLabel].slice(0, 100).join('');
  } catch {}
  const currentLabel = () => customLabel || sanitizeComputerLabel(os.hostname()) || os.hostname();
  const serialize = task => { writes = writes.catch(() => {}).then(task); return writes; };
  const save = async (filename, value) => { await writeFile(`${filename}.tmp`, JSON.stringify(value), { mode: 0o600 }); await rename(`${filename}.tmp`, filename); };
  const persistSettings = () => save(settingsPath, { permission, ...(customLabel ? { label: customLabel } : {}) });
  const publishPermission = async (value = permission) => {
    // The original Host has separate single-machine and per-machine stores.
    await command('setHostSettings', { localToolPermission: value });
    await command('setHostSettings', { localToolPermission: value, localToolPermissionMachineId: machineId });
  };
  const startProvider = () => {
    const instance = new original.Provider({ root, computerId: machineId, computerLabel: currentLabel(),
      resolveConnection: async () => ({ baseUrl: config.server, token: config.token }),
      isSupervised: async () => !window.isDestroyed(),
      messages: { available: () => false },
      isLocalUseBlocked: args => original.isLocalUseBlocked({ ...args, permission, messagesEnabled: false,
        approvalsPath, retirementsPath, standingGrantsPath }),
      onApprovalRetired: id => serialize(() => original.retireApproval(id, approvalsPath, retirementsPath)),
    });
    const streamRequests = instance.streamRequests.bind(instance);
    instance.streamRequests = async (...args) => { await publishPermission(); return streamRequests(...args); };
    instance.start();
    return instance;
  };
  let provider = startProvider();
  // Discovery does not delay the workspace. The shipped helper is started only
  // to read its own schemas; each GUI session retains its original app policy.
  const decideLocalUse = args => original.decideLocalUse({ ...args, permission, messagesEnabled: false,
    approvalsPath, retirementsPath, standingGrantsPath });
  void Promise.allSettled([
    createNativeComputer({ original, profile, enabled: () => permission !== 'never', decideLocalUse }),
    createCodexBridge({ profile, config, root, enabled: () => permission !== 'never', decideLocalUse }),
  ]).then(results => {
    const providers = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    if (results[1].status === 'fulfilled') codex = results[1].value;
    const computer = { tools: providers.flatMap(value => value.tools),
      call: (request, options) => providers.find(value => value.tools.some(tool => tool.name === request.toolId)).call(request, options),
      disconnected: () => codex?.stop(),
      close: () => providers.forEach(value => value.close()) };
    if (closed) return computer.close();
    native = startNativeProvider({ config, computer, label: currentLabel });
  }).catch(error => console.warn('[native-computer]', error.name));
  return {
    close: () => { closed = true; provider.close(); native?.close(); },
    handlers: {
      getLocalToolPermission: () => permission,
      setLocalToolPermission: async args => {
        if (!['ask', 'never', 'always'].includes(args?.permission)) throw new Error(grokText('无效的本机权限设置', 'Invalid local access permission'));
        if (args.machineId && args.machineId !== machineId) {
          throw new Error(grokText('请在该电脑上修改权限。', 'Change that computer\'s permission from its own Grok Bot app.'));
        }
        await publishPermission(args.permission);
        permission = args.permission; await serialize(persistSettings);
        if (permission === 'never') codex?.stop();
        return permission;
      },
      recordLocalToolApproval: args => serialize(async () => {
        if (args.machineId && args.machineId !== machineId) throw new Error(grokText('请在目标电脑确认审批。', 'Approve this request on the target computer.'));
        const record = original.parseApproval({ id: args.approvalId, action: args.action, target: args.target });
        if (!record) throw new Error(grokText('本机审批无效', 'Invalid local approval'));
        let entries = [];
        try { entries = JSON.parse(await readFile(approvalsPath, 'utf8')).approvals ?? []; } catch {}
        await save(approvalsPath, { approvals: [...entries.filter(item => item.id !== record.id), record].slice(-500) });
      }),
      clearLocalToolApprovals: () => serialize(async () => { await rm(approvalsPath, { force: true }); await rm(retirementsPath, { force: true }); }),
      getSandMachines: async () => {
        const currentMachine = {
          machineId,
          label: currentLabel(),
          platform: process.platform,
          connected: Boolean(provider.providerId),
          localToolPermission: permission,
        };
        if (typeof request !== 'function') return mergeSandMachines({ currentMachine, remotePayload: null });
        const remotePayload = await request('/local/computers', undefined, AbortSignal.timeout(10_000), 'GET').catch(() => null);
        return mergeSandMachines({ currentMachine, remotePayload });
      },
      updateSandMachineLabel: async ({ machineId: targetId, label } = {}) => {
        if (targetId && targetId !== machineId) throw new Error(grokText('请在该电脑上修改名称。', 'Rename that computer from its own Grok Bot app.'));
        const sanitized = sanitizeComputerLabel(label);
        if (!sanitized || [...sanitized].length > 100) throw new Error(grokText('无效的电脑名称', 'Invalid computer name'));
        if (sanitized !== customLabel) {
          customLabel = sanitized;
          await serialize(persistSettings);
          if (!closed && customLabel === sanitized) {
            provider.close();
            provider = startProvider();
            void native?.updateLabel();
          }
        }
        const connected = Boolean(provider.providerId);
        return {
          machineId,
          name: currentLabel(),
          label: currentLabel(),
          platform: process.platform,
          kind: 'desktop',
          isCurrent: true,
          connected,
          isOnline: connected,
          localToolPermission: permission,
        };
      },
      removeSandMachine: async () => {
        throw new Error('sand-machine/removal-refused: not_removable');
      },
      getLocalExecutionStatus: () => ({ connected: Boolean(provider.providerId), machineId, root, permission }),
    },
  };
}
