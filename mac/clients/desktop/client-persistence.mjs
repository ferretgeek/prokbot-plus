import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { grokText } from './i18n.mjs';

export function createClientPersistence(profile) {
  const file = path.join(profile, 'local-client-persistence.json');
  let state, queue = Promise.resolve();
  async function load() {
    if (state) return state;
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an object');
      state = Object.assign(Object.create(null), data);
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw new Error(grokText(
        '无法读取桌面设置文件 local-client-persistence.json；已保留原文件。',
        'Cannot read the desktop profile local-client-persistence.json. The original file was preserved.'), { cause });
      state = Object.create(null);
    }
    return state;
  }
  function ordered(task) {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }
  function update(edit) {
    return ordered(async () => {
      const next = Object.assign(Object.create(null), await load());
      edit(next);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        try { await handle.writeFile(JSON.stringify(next), 'utf8'); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }); throw error;
      }
      state = next; // A rejected disk write must not become visible or leak into the next save.
    });
  }
  const read = select => ordered(async () => select(await load()));
  return {
    readClientPersistence: ({ key }) => read(data => data[key] ?? null),
    readManyClientPersistence: ({ include, exclude = [] }) => read(data =>
      Object.fromEntries(Object.entries(data).filter(([key]) => {
        const longest = prefixes => prefixes.reduce((len, prefix) =>
          key.startsWith(prefix) ? Math.max(len, prefix.length) : len, -1);
        const length = longest(include);
        return length >= 0 && length >= longest(exclude);
      }))),
    writeClientPersistence: ({ key, value }) => update(data => { data[key] = value; }),
    removeClientPersistence: ({ key }) => update(data => { delete data[key]; }),
    listClientPersistenceKeys: ({ prefix }) => read(data => Object.keys(data).filter(key => key.startsWith(prefix))),
    hasMigratedClientPersistence: () => true,
    migrateClientPersistence: ({ entries }) => update(data => { for (const { key, value } of entries) data[key] = value; }),
  };
}
