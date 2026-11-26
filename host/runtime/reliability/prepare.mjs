import { readFile, writeFile, mkdir, mkdtemp, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { seedDigest, sha256 } from './seed-manifest.mjs';

// These outputs are generated locally from the user's original Host.
export async function prepareHostReliability(stateDirectory) {
  const app = new URL('../../', import.meta.url);
  const seed = new URL('seed/release-reliability/', app);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', seed), 'utf8'));
  if (seedDigest(manifest) !== manifest.digest || manifest.status.digest !== manifest.digest) {
    throw new Error('Prepared runtime manifest identity mismatch');
  }
  for (const file of manifest.runtimeFiles) {
    if (sha256(await readFile(new URL(file.name, app))) !== file.sha256) {
      throw new Error('Prepared runtime dependency integrity failure: ' + file.name);
    }
  }
  const contents = new Map();
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(file.name, seed));
    if (sha256(bytes) !== file.sha256) throw new Error('Prepared runtime integrity failure: ' + file.name);
    contents.set(file.name, bytes);
  }
  const libraryName = 'host-library-reliable.cjs';
  if (!contents.has(libraryName)) throw new Error('Prepared runtime library missing');
  const parent = join(stateDirectory, 'reliable-core');
  const directory = join(parent, manifest.digest.slice(0, 20));
  await mkdir(parent, { recursive: true });
  const existing = await lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && !existing.isDirectory()) throw new Error('Invalid prepared runtime cache directory');
  if (!existing) {
    const scratch = await mkdtemp(join(parent, '.seed-'));
    try {
      for (const [name, bytes] of contents) {
        if (name !== libraryName) await writeFile(join(scratch, name), bytes);
      }
      try { await rename(scratch, directory); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  for (const file of manifest.files) {
    if (file.name === libraryName) continue;
    const bytes = await readFile(join(directory, file.name)).catch(error => {
      throw new Error('Prepared runtime cache incomplete: ' + file.name, { cause: error });
    });
    if (sha256(bytes) !== file.sha256) throw new Error('Prepared runtime cache edited: ' + file.name);
  }
  const libraryPath = join(stateDirectory, libraryName);
  const temporary = await mkdtemp(join(stateDirectory, '.library-'));
  try {
    await writeFile(join(temporary, libraryName), contents.get(libraryName), { mode: 0o600 });
    await rename(join(temporary, libraryName), libraryPath);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return { directory, libraryPath, status: manifest.status };
}
