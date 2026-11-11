#!/usr/bin/env node
// Maintainers: build the unsigned shell APK and record it for the patcher.
//   node android/shell/release-shell.mjs
// Needs JDK 17+ and the Android SDK (ANDROID_HOME). Users never run this; they use
// the prebuilt android/dist/grokbot-android-shell.apk.
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
// The wrapper's main class runs directly, so cmd.exe never sees the (possibly non-ASCII) path.
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
execFileSync(java, ['-classpath', path.join(here, 'gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain',
  '--no-daemon', 'clean', 'assembleRelease'], { cwd: here, stdio: 'inherit' });
const built = path.join(here, 'app/build/outputs/apk/release/app-release-unsigned.apk');
const target = path.join(repo, 'android/dist/grokbot-android-shell.apk');
await copyFile(built, target);
const supportedPath = path.join(repo, 'android/patchers/supported.json');
const supported = JSON.parse(await readFile(supportedPath, 'utf8'));
supported.shell.sha256 = createHash('sha256').update(await readFile(target)).digest('hex');
await writeFile(supportedPath, JSON.stringify(supported, null, 2) + '\n');
console.log(JSON.stringify({ shell: path.relative(repo, target), sha256: supported.shell.sha256 }));
