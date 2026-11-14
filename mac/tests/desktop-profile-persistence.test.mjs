import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalServices } from '../clients/desktop/local-services.mjs';

async function fixture(t) {
  const profile = await mkdtemp(path.join(tmpdir(), 'plus-profile-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  return { profile, file: path.join(profile, 'local-client-persistence.json') };
}

test('a corrupt desktop profile is never replaced by a write, removal, or migration', async t => {
  const { profile, file } = await fixture(t);
  for (const original of ['{"saved":', '[]', 'null']) {
    await writeFile(file, original);
    const call = await createLocalServices(profile, {}, {});
    await assert.rejects(call('writeClientPersistence', { key: 'new', value: '1' }), /profile|设置/i);
    await assert.rejects(call('removeClientPersistence', { key: 'old' }), /profile|设置/i);
    await assert.rejects(call('migrateClientPersistence', { entries: [] }), /profile|设置/i);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await readdir(profile), [path.basename(file)]);
  }
});

test('a failed profile save is not visible in memory or on a later successful save', async t => {
  const { profile, file } = await fixture(t);
  await writeFile(file, JSON.stringify({ kept: 'old' }));
  const call = await createLocalServices(profile, {}, {});
  assert.equal(await call('readClientPersistence', { key: 'kept' }), 'old');
  const saved = path.join(profile, 'saved');
  await rename(file, saved); await mkdir(file);
  await assert.rejects(call('writeClientPersistence', { key: 'phantom', value: 'never committed' }));
  assert.equal(await call('readClientPersistence', { key: 'phantom' }), null);
  await rmdir(file); await rename(saved, file);
  const writes = Array.from({ length: 12 }, (_, i) => call('writeClientPersistence', { key: `slot${i}`, value: i }));
  await Promise.all(writes);
  const reopened = await createLocalServices(profile, {}, {});
  const all = await reopened('readManyClientPersistence', { include: [''] });
  assert.deepEqual(all, { kept: 'old', ...Object.fromEntries(writes.map((_, i) => [`slot${i}`, i])) });
  assert.deepEqual(await readdir(profile), [path.basename(file)]);
});

test('the desktop about dialog reports the running application, not a hard-coded vendor release', async t => {
  const { profile } = await fixture(t);
  for (const appVersion of ['0.71.2', '9.4.2']) {
    const call = await createLocalServices(profile, {}, { appVersion });
    const status = await call('getUpdateStatus');
    assert.equal(status.currentVersion, appVersion);
    assert.equal(status.state.type, 'disabled');
  }
});
