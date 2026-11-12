import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp, mkdir, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { previousImageLink, provisionResources } from '../runtime/host-resources.mjs';

test('deployment platform, mode selection and fail-closed upgrade paths', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [fileURLToPath(new URL('deployment_checks.py', import.meta.url))], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('only resource links from a sibling image revision belong to the updater', () => {
  const root = resolve('artifacts'), current = join(root, 'host-abc', 'sand-host');
  assert.ok(previousImageLink(join(root, 'host-def', 'sand-host', 'version'), current, 'version'));
  for (const target of [join(current, 'version'), join(root, 'host-def', 'sand-host', 'other'),
    join(root, 'user', 'sand-host', 'version'), resolve('other', 'host-def', 'sand-host', 'version')]) {
    assert.equal(previousImageLink(target, current, 'version'), false);
  }
});

test('refreshes a dangling image link but preserves user files and links', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, 'host-abc', 'sand-host'), state = join(root, 'state');
  await mkdir(src, { recursive: true }); await mkdir(state);
  for (const name of ['version', 'data', 'link']) await writeFile(join(src, name), 'new');
  await symlink(join(root, 'host-def', 'sand-host', 'version'), join(state, 'version'));
  await writeFile(join(state, 'data'), 'mine'); await symlink(join(state, 'data'), join(state, 'link'));
  await provisionResources(state, src);
  assert.equal(await readFile(join(state, 'version'), 'utf8'), 'new');
  for (const name of ['data', 'link']) assert.equal(await readFile(join(state, name), 'utf8'), 'mine');
});
