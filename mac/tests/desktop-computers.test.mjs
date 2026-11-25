import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalExec, mergeSandMachines } from '../clients/desktop/local-exec.mjs';

const require = createRequire(import.meta.url);

async function createExecFixture(t, { commandImpl, requestImpl } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'local-exec-machines-'));
  const payload = path.join(tmp, 'payload');
  const profile = path.join(tmp, 'profile');
  const daemonPath = path.join(payload, 'local-exec-daemon/main.cjs');
  await mkdir(path.dirname(daemonPath), { recursive: true });
  await writeFile(daemonPath, `
    const events = [];
    class Provider {
      constructor(opts) {
        this.opts = opts;
        this.providerId = null;
        events.push({ kind: 'create', computerId: opts.computerId, computerLabel: opts.computerLabel });
      }
      async streamRequests() {}
      start() { this.providerId = 'prov-' + this.opts.computerLabel; events.push({ kind: 'start', computerLabel: this.opts.computerLabel }); }
      close() { this.providerId = null; events.push({ kind: 'close', computerLabel: this.opts.computerLabel }); }
    }
    module.exports = {
      events,
      Provider,
      ComputerUse: class {},
      findComputerHelper: () => null,
      decideLocalUse: () => ({ allow: true }),
      isLocalUseBlocked: () => false,
      retireApproval: async () => {},
      parseApproval: value => value,
    };
  `);

  t.mock.method(globalThis, 'fetch', async () => new Response('', {
    headers: { 'content-type': 'text/event-stream' },
  }));

  const commands = [];
  let exec;
  t.after(async () => {
    exec?.close();
    await rm(tmp, { recursive: true, force: true });
  });
  exec = await createLocalExec({
    payload,
    profile,
    config: { deviceId: 'dev1', server: 'https://fixture.invalid', token: 'tok' },
    command: async (method, args) => {
      commands.push({ method, args });
      if (commandImpl) return commandImpl(method, args);
      return {};
    },
    request: requestImpl ?? (async urlPath => {
      assert.equal(urlPath, '/local/computers');
      return {
        available: true,
        computers: [
          { id: 'win-peer', label: 'Peer-PC', connected: true, platform: 'win32' },
        ],
      };
    }),
    window: { isDestroyed: () => false },
  });
  const providerEvents = require(daemonPath).events;
  return { exec, commands, profile, providerEvents };
}

test('mergeSandMachines maps current and remote /local/computers into official 1.3.0 Settings > Computer schema', () => {
  const merged = mergeSandMachines({
    currentMachine: {
      machineId: 'mac-self',
      label: 'Studio-Mac',
      platform: 'darwin',
      connected: false,
      localToolPermission: 'always',
    },
    remotePayload: {
      available: true,
      computers: [
        { id: 'mac-self', label: 'old-hostname', connected: true, platform: 'darwin' },
        { id: 'win-office', label: 'Office-PC', connected: true, platform: 'win32' },
        { id: 'linux-box', label: 'Workstation', connected: false },
      ],
    },
  });

  assert.deepEqual(merged, {
    currentMachineRemoved: false,
    machines: [
      {
        machineId: 'mac-self',
        name: 'Studio-Mac',
        label: 'Studio-Mac',
        platform: 'darwin',
        kind: 'desktop',
        isCurrent: true,
        connected: true,
        isOnline: true,
        localToolPermission: 'always',
      },
      {
        machineId: 'win-office',
        name: 'Office-PC',
        label: 'Office-PC',
        platform: 'win32',
        kind: 'desktop',
        isCurrent: false,
        connected: true,
        isOnline: true,
        localToolPermission: 'ask',
      },
      {
        machineId: 'linux-box',
        name: 'Workstation',
        label: 'Workstation',
        platform: 'unknown',
        kind: 'desktop',
        isCurrent: false,
        connected: false,
        isOnline: false,
        localToolPermission: 'ask',
      },
    ],
  });
});

test('createLocalExec handles getSandMachines, sanitized updateSandMachineLabel with provider re-registration, and rejects remote machine mutations', async t => {
  const { exec, commands, profile, providerEvents } = await createExecFixture(t);

  const initial = await exec.handlers.getSandMachines();
  assert.equal(initial.machines.length, 2);
  assert.equal(initial.machines[0].isCurrent, true);
  assert.equal(initial.machines[0].connected, true);
  assert.equal(initial.machines[1].machineId, 'win-peer');
  assert.equal(initial.machines[1].localToolPermission, 'ask');
  assert.equal(commands.some(c => c.method === 'getHostSettings'), false);

  const renamed = await exec.handlers.updateSandMachineLabel({
    machineId: initial.machines[0].machineId,
    label: '  My\r\nMacBook\tPro  ',
  });
  assert.equal(renamed.label, 'My MacBook Pro');
  assert.equal((await exec.handlers.getSandMachines()).machines[0].label, 'My MacBook Pro');

  const savedSettings = JSON.parse(await readFile(path.join(profile, 'local-exec/settings.json'), 'utf8'));
  assert.equal(savedSettings.label, 'My MacBook Pro');

  assert.ok(providerEvents.some(e => e.kind === 'close'));
  assert.ok(providerEvents.some(e => e.kind === 'start' && e.computerLabel === 'My MacBook Pro'));

  // Label validation and target checks
  await assert.rejects(
    () => exec.handlers.updateSandMachineLabel({ machineId: initial.machines[0].machineId, label: '' }),
    /无效的电脑名称|Invalid computer name/,
  );
  await assert.rejects(
    () => exec.handlers.updateSandMachineLabel({ machineId: initial.machines[0].machineId, label: ' \r\n\t ' }),
    /无效的电脑名称|Invalid computer name/,
  );
  await assert.rejects(
    () => exec.handlers.updateSandMachineLabel({ machineId: initial.machines[0].machineId, label: 'x'.repeat(101) }),
    /无效的电脑名称|Invalid computer name/,
  );
  await assert.rejects(
    () => exec.handlers.updateSandMachineLabel({ machineId: 'win-peer', label: 'OtherName' }),
    /请在该电脑上修改名称|Rename that computer/,
  );

  // Remote permission changes are rejected rather than spoofed in client memory
  await assert.rejects(
    () => exec.handlers.setLocalToolPermission({ permission: 'never', machineId: 'win-peer' }),
    /请在该电脑上修改权限|Change that computer/,
  );
  assert.equal(commands.some(c => c.args?.localToolPermissionMachineId === 'win-peer'), false);

  // Local permission changes continue to work
  assert.equal(await exec.handlers.setLocalToolPermission({ permission: 'never', machineId: initial.machines[0].machineId }), 'never');
  assert.equal(await exec.handlers.getLocalToolPermission(), 'never');

  await assert.rejects(() => exec.handlers.removeSandMachine(), /sand-machine\/removal-refused: not_removable/);
});

test('getSandMachines falls back to current computer only when /local/computers fails or times out', async t => {
  for (const error of [
    Object.assign(new Error('Forbidden'), { httpStatus: 403 }),
    Object.assign(new Error('Not Found'), { httpStatus: 404 }),
    Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
  ]) {
    const { exec } = await createExecFixture(t, {
      requestImpl: async () => { throw error; },
    });
    const res = await exec.handlers.getSandMachines();
    assert.equal(res.currentMachineRemoved, false);
    assert.equal(res.machines.length, 1);
    assert.equal(res.machines[0].isCurrent, true);
    assert.equal(res.machines[0].connected, true);
  }
});
