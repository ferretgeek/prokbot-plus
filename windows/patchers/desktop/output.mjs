import { link, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Resolve existing ancestors as well: a not-yet-created output under a junction
// can otherwise land inside the original just as easily as a lexical child.
export async function physicalPath(name) {
  name = path.resolve(name);
  try { return await realpath(name); } catch (error) {
    const parent = path.dirname(name);
    if (error.code !== 'ENOENT' || parent === name) throw error;
    return path.join(await physicalPath(parent), path.basename(name));
  }
}

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

export async function checkOutputLocation(source, root, targets) {
  const original = await realpath(source);
  if (inside(original, await physicalPath(root))) throw new Error(`Output would modify the source: ${root}`);
  for (const target of targets) {
    const name = await physicalPath(target);
    if (inside(original, name) || inside(name, original)) throw new Error(`Output overlaps the source: ${target}`);
    try { await lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`输出已存在，不会覆盖：${target}`);
  }
}

// A failed open must never enroll someone else's file in cleanup. Close the
// exclusive handle on every failure (including short writes and final close).
export async function writeNewFile(destination, write) {
  const file = await open(destination, 'wx');
  try {
    try { await write(file); } finally { await file.close(); }
  } catch (error) {
    await rm(destination);
    throw error;
  }
}

export async function writeSetup(stub, archive, destination, expectedZipBytes) {
  await writeNewFile(destination, async file => {
    const sizes = [];
    for (const name of [stub, archive]) {
      let bytes = 0;
      for await (const chunk of createReadStream(name)) {
        await file.writeFile(chunk);
        bytes += chunk.length;
      }
      sizes.push(bytes);
    }
    if (!sizes[0] || sizes[1] !== expectedZipBytes) throw new Error('Incomplete installer inputs');
    const footer = Buffer.alloc(32);
    footer.writeBigUInt64LE(BigInt(sizes[0]), 0); footer.writeBigUInt64LE(BigInt(sizes[1]), 8);
    footer.write('GROKBOT-SETUP-V1', 16, 'latin1');
    await file.writeFile(footer);
  });
}

// Publish verified files without clobbering an existing name. Hard links are
// atomic on NTFS; the exclusive copy also works across volumes and on FAT.
async function publishFile(source, destination) {
  try { await link(source, destination); } catch (error) {
    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(error.code)) throw error;
    await writeNewFile(destination, async file => {
      for await (const chunk of createReadStream(source)) await file.writeFile(chunk);
    });
  }
}

const digest = async name => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(name)) hash.update(chunk);
  return hash.digest('hex');
};

// The portable directory is the last publication. On Windows a directory move
// cannot replace an existing destination, so rollback never removes a public tree.
export async function publishBuild(stagedApp, appOutput, files) {
  const published = [];
  try {
    for (const { source, destination, sha256 } of files) {
      await publishFile(source, destination);
      const info = await lstat(destination, { bigint: true });
      published.push({ destination, sha256, info });
    }
    await rename(stagedApp, appOutput);
  } catch (error) {
    const failures = [];
    for (const { destination, sha256, info } of published.reverse()) {
      try {
        const current = await lstat(destination, { bigint: true });
        if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino ||
            await digest(destination) !== sha256)
          throw new Error(`Leaving changed output in place: ${destination}`);
        await rm(destination);
      } catch (failure) { if (failure.code !== 'ENOENT') failures.push(failure); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], [error, ...failures].map(e => e.message).join('\n'));
    throw error;
  }
}
