import { lstat, readlink, readdir, rename, symlink, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Only links pointing into a sibling image-owned Host revision may be replaced.
export function previousImageLink(target, originalDir, name) {
  const revision = dirname(dirname(target));
  return basename(originalDir) === 'sand-host' && /^host-[0-9a-f]+$/.test(basename(dirname(originalDir))) &&
    dirname(revision) === dirname(dirname(originalDir)) && /^host-[0-9a-f]+$/.test(basename(revision)) &&
    target === join(revision, 'sand-host', name) && target !== join(originalDir, name);
}

export async function provisionResources(stateDir, originalDir) {
  for (const entry of await readdir(originalDir, { withFileTypes: true })) {
    if (['host-main.cjs', 'package.json', 'sand-eval-runner.cjs'].includes(entry.name)) continue;
    const dst = join(stateDir, entry.name), src = join(originalDir, entry.name);
    const existing = await lstat(dst).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!existing) { await symlink(src, dst, entry.isDirectory() ? 'dir' : 'file'); continue; }
    if (!existing.isSymbolicLink() || !previousImageLink(resolve(stateDir, await readlink(dst)), originalDir, entry.name)) continue;
    const tmp = `${dst}.${randomUUID()}.tmp`;
    await symlink(src, tmp, entry.isDirectory() ? 'dir' : 'file');
    try { await rename(tmp, dst); } catch (error) { await unlink(tmp); throw error; }
  }
}
