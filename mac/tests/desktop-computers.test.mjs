import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalExec, mergeSandMachines } from '../clients/desktop/local-exec.mjs';

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
        { id: 'linux-box', label: 'Workstation', connected: false, platform: 'linux' },
      ],
    },
    perMachinePermissions: {
      'win-office': 'never',
      'linux-box': 'invalid',
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
        localToolPermission: 'never',
      },
      {
        machineId: 'linux-box',
        name: 'Workstation',
        label: 'Workstation',
        platform: 'linux',
        kind: 'desktop',
        isCurrent: false,
        connected: false,
        isOnline: false,
        localToolPermission: 'ask',
      },
    ],
  });
});

test('createLocalExec handles getSandMachines, updateSandMachineLabel, removeSandMachine, and remote machine permissions', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'local-exec-machines-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const payload = path.join(tmp, 'payload');
  const profile = path.join(tmp, 'profile');
  await mkdir(path.join(payload, 'local-exec-daemon'), { recursive: true });
  await writeFile(path.join(payload, 'local-exec-daemon/main.cjs'), `
    class Provider {
      constructor(opts) { this.opts = opts; this.providerId = 'prov-1'; }
      async streamRequests() {}
      start() {}
      close() { this.providerId = null; }
    }
    module.exports = {
      Provider,
      ComputerUse: class {},
      findComputerHelper: () => null,
      decideLocalUse: () => ({ allow: true }),
      isLocalUseBlocked: () => false,
      retireApproval: async () => {},
      parseApproval: value => value,
    };
  `);

  const commands = [];
  const exec = await createLocalExec({
    payload,
    profile,
    config: { deviceId: 'dev1', server: 'https://fixture.invalid', token: 'tok' },
    command: async (method, args) => {
      commands.push({ method, args });
      if (method === 'getHostSettings') return { localToolPermissions: { 'win-peer': 'always' } };
      return {};
    },
    request: async urlPath => {
      assert.equal(urlPath, '/local/computers');
      return {
        available: true,
        computers: [
          { id: 'win-peer', label: 'Peer-PC', connected: true, platform: 'win32' },
        ],
      };
    },
    window: { isDestroyed: () => false },
  });
  t.after(() => exec.close());

  const initial = await exec.handlers.getSandMachines();
  assert.equal(initial.machines.length, 2);
  assert.equal(initial.machines[0].isCurrent, true);
  assert.equal(initial.machines[0].connected, true);
  assert.equal(initial.machines[1].machineId, 'win-peer');
  assert.equal(initial.machines[1].localToolPermission, 'always');

  const renamed = await exec.handlers.updateSandMachineLabel({
    machineId: initial.machines[0].machineId,
    label: 'My MacBook',
  });
  assert.equal(renamed.label, 'My MacBook');
  assert.equal((await exec.handlers.getSandMachines()).machines[0].label, 'My MacBook');

  await exec.handlers.setLocalToolPermission({ permission: 'never', machineId: 'win-peer' });
  assert.ok(commands.some(c => c.method === 'setHostSettings' && c.args.localToolPermissionMachineId === 'win-peer' && c.args.localToolPermission === 'never'));
  assert.equal((await exec.handlers.getSandMachines()).machines[1].localToolPermission, 'never');

  await assert.rejects(() => exec.handlers.removeSandMachine(), /sand-machine\/removal-refused: not_removable/);
});
