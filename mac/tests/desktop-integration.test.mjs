import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as desktop from '../clients/desktop/platform.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'prokbot-integration-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const link = path.join(dir, 'Microsoft', 'Windows', 'Start Menu', 'Programs', desktop.SHORTCUT_NAME);
  await mkdir(path.dirname(link), { recursive: true });
  return { dir, link, exe: path.join(dir, 'client.exe'), app: { getPath: () => dir } };
}

test('startup never replaces an existing shortcut pointing at another program or an unreadable file', async t => {
  const { dir, link, exe, app } = await fixture(t);
  await writeFile(link, 'fixture owned by another installation');
  let writes = 0;
  for (const readShortcutLink of [() => ({ target: path.join(dir, 'other.exe') }), () => { throw new Error('not a link'); }]) {
    const shell = { readShortcutLink, writeShortcutLink: () => { writes++; return true; } };
    assert.equal(desktop.ensureStartMenuShortcut({ app, shell, execPath: exe }), false);
  }
  assert.equal(writes, 0);
});

test('startup creates a missing shortcut and only adds the toast ID to its own existing link', async t => {
  const { link, exe, app } = await fixture(t);
  const writes = [], shell = { readShortcutLink: () => ({ target: exe, args: '--existing' }),
    writeShortcutLink: (...args) => { writes.push(args); if (args[1] === 'create') writeFileSync(args[0], 'test link'); return true; } };
  assert.equal(desktop.ensureStartMenuShortcut({ app, shell, execPath: exe }), true);
  assert.equal(writes[0][1], 'create');
  await writeFile(link, 'existing link');
  assert.equal(desktop.ensureStartMenuShortcut({ app, shell, execPath: exe }), true);
  assert.deepEqual(writes[1], [link, 'update', { appUserModelId: desktop.APP_USER_MODEL_ID }]);
  shell.readShortcutLink = () => ({ target: exe, appUserModelId: desktop.APP_USER_MODEL_ID });
  assert.equal(desktop.ensureStartMenuShortcut({ app, shell, execPath: exe }), false);
  assert.equal(writes.length, 2);
});

test('isolated profiles and Windows side-by-side installations cannot claim OS integration on launch', async t => {
  const { dir, exe } = await fixture(t);
  const opts = { execPath: exe, platform: 'win32', isolatedProfile: false };
  const permit = overrides => desktop.canRegisterDesktopIntegration({ ...opts, ...overrides });
  assert.equal(await permit({ isolatedProfile: true }), false);
  assert.equal(await permit({ platform: 'darwin', isolatedProfile: true }), false);
  assert.equal(await permit({}), true, 'portable install without a receipt');
  const file = path.join(dir, '.grokbot-installation.json');
  const receipt = { format: 1, appId: desktop.APP_USER_MODEL_ID, directory: dir };
  await writeFile(file, JSON.stringify({ ...receipt, sideBySideOf: path.join(dir, 'old') }));
  assert.equal(await permit({}), false);
  await writeFile(file, 'invalid');
  assert.equal(await permit({}), false);
  await writeFile(file, JSON.stringify({ ...receipt, directory: path.dirname(dir) }));
  assert.equal(await permit({}), false);
  await writeFile(file, JSON.stringify(receipt));
  assert.equal(await permit({}), true);
});

test('a shortcut created concurrently wins without being overwritten', async t => {
  const { link, exe, app } = await fixture(t);
  const shell = { writeShortcutLink(stage) {
    writeFileSync(stage, 'candidate'); writeFileSync(link, 'user link'); return true;
  } };
  assert.equal(desktop.ensureStartMenuShortcut({ app, shell, execPath: exe }), false);
  assert.equal(readFileSync(link, 'utf8'), 'user link');
});
