import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function canonical(file) {
  try { return await realpath(file); } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(file) === file) throw error;
    return path.join(await canonical(path.dirname(file)), path.basename(file));
  }
}

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function existingTarget(target, force) {
  let info;
  try { info = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!force) throw new Error(`输出已存在，不会覆盖（可加 --force）：${target}`);
  if (!info.isFile()) throw new Error(`输出不是普通文件，不会覆盖：${target}`);
  return true;
}

// Reject overlaps before creating the key or modifying the output directory.
export async function checkBuildOutput({ source, shell, key, targets, force }) {
  const [original, shellFile, keyFile] = await Promise.all([source, shell, key].map(canonical));
  if (inside(original, keyFile) || inside(shellFile, keyFile)) throw new Error('签名密钥位置与输入重叠。');
  for (const target of targets) {
    const file = await canonical(target);
    if ([original, shellFile, keyFile].some(input => inside(input, file) || inside(file, input)))
      throw new Error(`输出位置与输入或签名密钥重叠：${target}`);
    await existingTarget(target, force);
  }
}

async function publishNew(source, target) {
  try { await link(source, target); } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL', 'EXDEV'].includes(error.code)) throw error;
    await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

// Stage both artifacts on the destination volume. Never replace an unclaimed name, and
// keep prior files recoverable if the filesystem also refuses a rollback operation.
export async function writeBuildOutput(root, entries, force) {
  await mkdir(root, { recursive: true });
  const stage = await mkdtemp(path.join(root, '.grokbot-android-build-'));
  const backups = [], published = [];
  let keepStage = false;
  try {
    for (const [i, { bytes }] of entries.entries()) await writeFile(path.join(stage, `new-${i}`), bytes, { flag: 'wx' });
    for (const [i, { target }] of entries.entries()) {
      if (await existingTarget(target, force)) {
        const backup = path.join(stage, `previous-${i}`);
        await rename(target, backup);
        backups.push({ backup, target });
      }
      await publishNew(path.join(stage, `new-${i}`), target);
      published.push(target);
    }
  } catch (error) {
    const failures = [];
    for (const target of published.reverse()) {
      try { await unlink(target); } catch (cause) { failures.push(cause); }
    }
    for (const { backup, target } of backups.reverse()) {
      try { await publishNew(backup, target); } catch (cause) { failures.push(cause); }
    }
    if (failures.length) {
      keepStage = true;
      throw new AggregateError([error, ...failures], `发布失败，无法完成回滚；已保留暂存文件：${stage}`, { cause: error });
    }
    throw error;
  } finally {
    if (!keepStage) await rm(stage, { recursive: true, force: true });
  }
}
