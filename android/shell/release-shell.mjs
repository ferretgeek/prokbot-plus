#!/usr/bin/env node
// Maintainers: build the unsigned shell APK and record it for the patcher.
//   node android/shell/release-shell.mjs [--offline]
// Needs JDK 17+ and the Android SDK (ANDROID_HOME). Users never run this; they use
// the prebuilt android/dist/grokbot-android-shell.apk.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readZip } from '../patchers/apk.mjs';
import { checkVersionAdvance, readShellManifest, verifyShellVersion } from '../patchers/shell-version.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--offline' && arg !== '--help')) throw new Error('Unknown argument. Use --help for usage.');
if (args.includes('--help')) {
  console.log('node android/shell/release-shell.mjs [--offline]\nGradle uses --no-daemon --max-workers=1. --offline uses cached Gradle dependencies.');
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
// The wrapper's main class runs directly, so cmd.exe never sees the (possibly non-ASCII) path.
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
execFileSync(java, ['-classpath', path.join(here, 'gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain',
  '--no-daemon', '--max-workers=1', ...(args.includes('--offline') ? ['--offline'] : []), 'clean', 'assembleRelease'],
{ cwd: here, stdio: 'inherit' });
const built = path.join(here, 'app/build/outputs/apk/release/app-release-unsigned.apk');
const supportedPath = path.join(repo, 'android/patchers/supported.json');
const supported = JSON.parse(await readFile(supportedPath, 'utf8'));
const target = path.join(repo, supported.shell.path);
const bytes = await readFile(built);
const actual = verifyShellVersion(readZip(bytes).entries, supported.shell);
const prior = await readFile(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (prior) checkVersionAdvance(readShellManifest(readZip(prior).entries), actual);
await writeFile(target, bytes);
supported.shell.sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(supportedPath, JSON.stringify(supported, null, 2) + '\n');
console.log(JSON.stringify({ shell: supported.shell, rendererVersion: supported.desktopVersion }));
