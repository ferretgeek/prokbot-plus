import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve, dirname, sep } from 'node:path';

const schema = 'grokbot-release-seed/v2';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const order = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function records(entries, runtime = false) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Empty seed manifest records');
  const names = new Set();
  return entries.map(entry => {
    const { name, sha256: hash } = entry;
    if (typeof name !== 'string' || !/^[\w./-]+$/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')
        || (runtime ? !name.startsWith('runtime/') : name.includes('/') || name === 'manifest.json')
        || names.has(name) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid seed manifest record: ' + name);
    names.add(name);
    return { name, sha256: hash };
  }).sort(order);
}

export function seedDigest(manifest) {
  if (manifest.schema !== schema) throw new Error('Unsupported seed manifest schema');
  return sha256(JSON.stringify({ schema, files: records(manifest.files), runtimeFiles: records(manifest.runtimeFiles, true) }));
}

/** Hash the bytes being shipped, including the runtime modules imported by generated code. */
export async function createSeedManifest(seedDirectory, runtimeDirectory, status) {
  const files = [], roots = [];
  for (const name of (await readdir(seedDirectory)).filter(name => name !== 'manifest.json').sort()) {
    const bytes = await readFile(join(seedDirectory, name));
    files.push({ name, sha256: sha256(bytes) });
    if (/\.[cm]js$/.test(name)) {
      for (const match of bytes.toString().matchAll(/["']file:\/\/\/opt\/grokbot\/runtime\/([^"'\n]+\.mjs)["']/g)) {
        roots.push(resolve(runtimeDirectory, match[1]));
      }
    }
  }
  const runtimeFiles = [], visited = new Set();
  while (roots.length) {
    // Manifest names use "/" so a manifest written on Windows matches the image.
    const file = roots.pop(), name = relative(runtimeDirectory, file).split(sep).join('/');
    if (name.startsWith('../') || name === '..') throw new Error('Runtime dependency escapes runtime: ' + file);
    if (visited.has(file)) continue;
    visited.add(file);
    const bytes = await readFile(file);
    runtimeFiles.push({ name: 'runtime/' + name, sha256: sha256(bytes) });
    for (const match of bytes.toString().matchAll(/["'](\.{1,2}\/[^"'\n]+\.mjs)["']/g)) roots.push(resolve(dirname(file), match[1]));
  }
  const manifest = { schema, files: files.sort(order), runtimeFiles: runtimeFiles.sort(order), status: { ...status } };
  manifest.digest = seedDigest(manifest);
  manifest.status.digest = manifest.digest;
  return manifest;
}

export async function writeSeedManifest(seedDirectory, runtimeDirectory, status) {
  const manifest = await createSeedManifest(seedDirectory, runtimeDirectory, status);
  await writeFile(join(seedDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
