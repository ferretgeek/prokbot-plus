import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { enhancePromptToolsBindings } from '../runtime/recovered-prompt-tools.mjs';
import {
  DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
  SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES,
  SHELL_ENRICHMENT_PREVIEW_MAX_CHARS,
  SHELL_ENRICHMENT_PREVIEW_MAX_LINES,
  buildExecutableProbeCommand,
  detectBinaryFormat,
  parseExecutableProbeOutput,
  parseInterpreterInvocation,
  readAutoReviewClassifierMaxAttempts,
  wrapSandShellAutoReviewTargetEnrichment,
} from '../runtime/shell-auto-review-enrichment.mjs';

const execFileAsync = promisify(execFile);

test('parseInterpreterInvocation uses strict flag allowlists and keeps unknown flags, unseen-file loaders, and dangerous env prefixes on stock path', () => {
  assert.equal(SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES, 256 * 1024 * 1024);

  // Inline / version / heredoc flags with no unseen external file must resolve to no-script-file.
  for (const command of [
    'node -v',
    'node --version',
    'node -e "console.log(1)"',
    'node --eval="console.log(1)"',
    'node -p "1+1"',
    'node -pe "1+1"',
    'node --no-warnings -e "console.log(1)"',
    'python3 -V',
    'python3 -VV',
    'python3 --version',
    'python3 -c "print(1)"',
    'python3 -c"print(1)"',
    'python3 -uc "print(1)"',
    'python3 - <<\'PY\'\nprint(1)\nPY',
    'bash -lc "ls -la"',
    'bash --noprofile --norc -c "echo hi"',
    'sh -c "echo hi"',
    'zsh -s',
    'cd /workspace/work && HOME=/workspace/.toolhome python3 -c "print(1)"',
    'env NODE_ENV=test node -v',
    'MSG="NODE_OPTIONS=1 BASH_ENV=2" node -v',
  ]) {
    const parsed = parseInterpreterInvocation(command, '/workspace');
    assert.equal(parsed?.kind, 'no-script-file', `Expected no-script-file for: ${command}`);
  }

  // Real scripts after allowlisted option flags resolve to the actual script path (never a flag value).
  assert.equal(
    parseInterpreterInvocation('python3 -u ./scripts/report.py --flag', '/workspace')?.path,
    '/workspace/scripts/report.py',
  );
  assert.equal(
    parseInterpreterInvocation('python3 -W ignore /workspace/tools/check.py', '/workspace')?.path,
    '/workspace/tools/check.py',
  );
  assert.equal(
    parseInterpreterInvocation('python3 -Wonce -Xtracemalloc ./scripts/report.py', '/workspace')?.path,
    '/workspace/scripts/report.py',
  );
  assert.equal(
    parseInterpreterInvocation('python3 -uW ignore evil.py', '/workspace')?.path,
    '/workspace/evil.py',
  );
  assert.equal(
    parseInterpreterInvocation('python3 -uWignore evil.py', '/workspace')?.path,
    '/workspace/evil.py',
  );
  assert.equal(
    parseInterpreterInvocation('python3 -uX dev evil.py', '/workspace')?.path,
    '/workspace/evil.py',
  );
  assert.equal(
    parseInterpreterInvocation('bash -euo pipefail ./deploy.sh --dry-run', '/workspace')?.path,
    '/workspace/deploy.sh',
  );
  assert.equal(
    parseInterpreterInvocation('bash -O extglob evil.sh', '/workspace')?.path,
    '/workspace/evil.sh',
  );
  assert.equal(
    parseInterpreterInvocation('bash +O extglob evil.sh', '/workspace')?.path,
    '/workspace/evil.sh',
  );
  assert.equal(
    parseInterpreterInvocation('node --unhandled-rejections strict evil.js', '/workspace')?.path,
    '/workspace/evil.js',
  );
  assert.equal(
    parseInterpreterInvocation('node --stack-size=100 evil.js', '/workspace')?.path,
    '/workspace/evil.js',
  );
  assert.equal(
    parseInterpreterInvocation('node --inspect --enable-source-maps --no-warnings app.js', '/workspace')?.path,
    '/workspace/app.js',
  );
  assert.equal(
    parseInterpreterInvocation('node --inspect=9229 app.js', '/workspace')?.path,
    '/workspace/app.js',
  );

  // Unknown flags, disallowed loaders/runners, file redirects, dangerous env prefixes,
  // direct script invocations, and bare interpreters must defer to stock logic (null).
  for (const command of [
    'python3 ./script.py',
    'npm run build',
    'HOME=/workspace/.toolhome /workspace/bin/demo-cli --status',
    'bash',
    // Node preload / config / runner / test / unknown flags
    'node -r ./preload.js -e "console.log(1)"',
    'node -e "console.log(1)" -r ./preload.js',
    'node --require=./preload.js -e "console.log(1)"',
    'node --import ./hook.mjs -e "console.log(1)"',
    'node --loader ./loader.mjs -v',
    'node --experimental-loader ./loader.mjs -v',
    'node --no-warnings --env-file .env scripts/run.mjs',
    'node --env-file=.env -e "console.log(process.env.X)"',
    'node --env-file-if-exists .env -v',
    'node --run build',
    'node --test',
    'node --test --test-reporter spec',
    'node --test-reporter=./x.mjs --test',
    'node --stack-size 100 evil.js',
    'node --experimental-config-file=x.json -e 1',
    'node --experimental-default-config-file -e 1',
    'node --openssl-config=./x.cnf -e 1',
    'node --openssl-config ./x.cnf -e 1',
    'node --unknown-flag decoy evil.js',
    // Shell rcfile / redirect / unknown flags
    'bash --rcfile ./custom.rc -c "echo hi"',
    'bash --init-file=./custom.rc -c "echo hi"',
    'bash -s --rcfile ./custom.rc',
    'sh -O extglob evil.sh',
    'bash -Z decoy evil.sh',
    'bash --unknown-flag decoy evil.sh',
    'sh -s < ./secret.sh',
    'bash < ./secret.sh',
    // Python -m / missing value / unknown flags / redirect
    'python3 - < ./secret.py',
    'python3 -m json.tool',
    'python3 -mhttp.server',
    'python3 -um http.server',
    'python3 -Im mymod',
    'python3 -uW',
    'python3 -i evil.py',
    'python3 --unknown-flag decoy evil.py',
    // Dangerous environment variable prefixes
    'NODE_OPTIONS="--require ./x.js" node -e 1',
    'env NODE_OPTIONS="--import ./x.mjs" node -v',
    'NODE_PATH=./evil node -e 1',
    'OPENSSL_CONF=./x.cnf node -e 1',
    'BASH_ENV=./x.sh bash -c true',
    'cd /workspace && BASH_ENV=./x.sh bash -c true',
    'ENV=./x.sh sh -c true',
    'ZDOTDIR=./x zsh -c true',
    'LD_PRELOAD=./x.so python3 -c 1',
    'DYLD_INSERT_LIBRARIES=./x.dylib python3 -c 1',
    'PYTHONPATH=./evil python3 -c "import x"',
    'PYTHONSTARTUP=./x.py python3 -V',
  ]) {
    assert.equal(parseInterpreterInvocation(command, '/workspace'), null, `Expected null for: ${command}`);
  }
});

test('detectBinaryFormat and parseExecutableProbeOutput classify binaries and large text scripts cleanly', () => {
  assert.equal(detectBinaryFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])), 'elf');
  assert.equal(detectBinaryFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00])), 'macho');
  assert.equal(detectBinaryFormat(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), 'pe');
  assert.equal(detectBinaryFormat(Buffer.from([0x01, 0x02, 0x00, 0x03])), 'binary');
  assert.equal(detectBinaryFormat(Buffer.from('#!/usr/bin/env bash\necho ok\n', 'utf8')), null);

  const elfB64 = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]).toString('base64');
  const digest = 'a'.repeat(64);
  const elfParsed = parseExecutableProbeOutput(
    `stat=1:2:278438600:1700000000:1700000000:755\nsize=278438600\nscope=full-sha256\nsha256=${digest}\nhead_b64=${elfB64}\n`,
    '/workspace/bin/demo-cli',
  );
  assert.deepEqual(elfParsed, {
    kind: 'binary_executable',
    path: '/workspace/bin/demo-cli',
    format: 'elf',
    size_bytes: 278438600,
    definition_hash: digest,
    hash_scope: 'full-sha256',
    truncated: true,
  });

  // Partial hash scopes are rejected cleanly.
  assert.equal(
    parseExecutableProbeOutput(
      `stat=1:2:278438600:1700000000:1700000000:755\nsize=278438600\nscope=stat-head-tail-64k\nsha256=${digest}\nhead_b64=${elfB64}\n`,
      '/workspace/bin/demo-cli',
    ),
    undefined,
  );

  const manyLines = Array.from({ length: 260 }, (_, i) => `line_${i + 1}`).join('\n');
  const textParsed = parseExecutableProbeOutput(
    `stat=1:3:${Buffer.byteLength(manyLines)}:1700000000:1700000000:644\nsize=${Buffer.byteLength(manyLines)}\nscope=full-sha256\nsha256=${digest}\nhead_b64=${Buffer.from(manyLines).toString('base64')}\n`,
    '/workspace/big.py',
  );
  assert.equal(textParsed.kind, 'executable');
  assert.equal(textParsed.path, '/workspace/big.py');
  assert.equal(textParsed.definition_hash, digest);
  assert.equal(textParsed.truncated, true);
  assert.equal(textParsed.definition.split('\n').length, SHELL_ENRICHMENT_PREVIEW_MAX_LINES);
  assert.ok(textParsed.definition.length <= SHELL_ENRICHMENT_PREVIEW_MAX_CHARS);
});

test('wrapSandShellAutoReviewTargetEnrichment preserves stock package-manager checks and binds targets cross-platform', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shell-auto-review-cross-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bigScriptPosix = '/workspace/big_script.py';
  const bigScriptReal = path.join(dir, 'big_script.py');
  const bigScriptBody = Array.from({ length: 250 }, (_, i) => `print("step ${i + 1}")`).join('\n') + '\n';
  await writeFile(bigScriptReal, bigScriptBody, 'utf8');

  const elfPosix = '/workspace/bin/demo-cli';
  const elfReal = path.join(dir, 'demo-cli');
  const elfBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(1024, 0x41)]);
  await writeFile(elfReal, elfBytes);

  const quotedPosix = "/workspace/it's a script.py";
  const quotedReal = path.join(dir, "it's a script.py");
  await writeFile(quotedReal, 'print("quoted")\n', 'utf8');

  const fileMap = new Map([
    [bigScriptPosix, bigScriptReal],
    [elfPosix, elfReal],
    [quotedPosix, quotedReal],
    ['/workspace/small.py', null],
  ]);

  const probeCmd = buildExecutableProbeCommand(elfPosix);
  assert.match(probeCmd, /^\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin \/bin\/sh -c '/);

  const shellExecutorResource = Symbol('shellExecutor');
  const accessor = {
    get(resource) {
      assert.equal(resource, shellExecutorResource);
      return {
        async execute(_ctx, args) {
          // Extract targetPath passed as final quoted `$1` argument to `/bin/sh -c ... _ <targetPath>`.
          const match = / _ '((?:[^']|'\\'')*)'$/.exec(args.command);
          assert.ok(match, `Unexpected probe command shape: ${args.command}`);
          const targetPath = match[1].replaceAll("'\\''", "'");
          const realPath = fileMap.get(targetPath);
          if (!realPath) {
            return { result: { case: 'failure', value: { aborted: false, exitCode: 2, stdout: '', stderr: '' } } };
          }
          const buf = await readFile(realPath);
          const info = await stat(realPath);
          const maxBytesMatch = /\[ "\$sz" -le (\d+) \]/.exec(args.command);
          if (maxBytesMatch && info.size > Number(maxBytesMatch[1])) {
            return { result: { case: 'failure', value: { aborted: false, exitCode: 5, stdout: '', stderr: '' } } };
          }
          const sha256 = createHash('sha256').update(buf).digest('hex');
          const headB64 = buf.subarray(0, SHELL_ENRICHMENT_PREVIEW_MAX_CHARS).toString('base64');
          const stdout = `stat=1:2:${info.size}:1700000000:1700000000:755\nsize=${info.size}\nscope=full-sha256\nsha256=${sha256}\nhead_b64=${headB64}\n`;
          return { result: { case: 'success', value: { exitCode: 0, stdout, stderr: '' } } };
        },
      };
    },
  };

  let stockCalls = [];
  const wrapped = wrapSandShellAutoReviewTargetEnrichment(
    async (_ctx, args) => {
      stockCalls.push(args.command);
      if (/\b(?:npm|pnpm|yarn)\b/.test(args.command)) {
        return { kind: 'package_script_unresolved', invocation: args.command, approval_binding_unavailable: true };
      }
      if (args.command.includes('small.py')) {
        return { kind: 'executable', path: '/workspace/small.py', definition: 'print(1)', definition_hash: 'b'.repeat(64), truncated: false };
      }
      const strippedCmd = args.command.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '');
      const parts = strippedCmd.trim().split(/\s+/);
      if (parts.length >= 2 && /^(python3|node|bash|sh|zsh)$/.test(parts[0])) {
        const candidate = parts[1].replace(/^['"]|['"]$/g, '');
        const resolved = candidate.startsWith('/') ? candidate : path.posix.resolve(args.workingDirectory ?? '/', candidate);
        return {
          kind: 'executable',
          path: resolved,
          approval_binding_unavailable: true,
          approval_binding_nonce: 'nonce-1',
        };
      }
      const absMatch = /(\/[^\s'"]+)/.exec(strippedCmd);
      return {
        kind: 'executable',
        path: absMatch ? absMatch[1] : '/workspace/missing.sh',
        approval_binding_unavailable: true,
        approval_binding_nonce: 'nonce-2',
      };
    },
    { shellExecutorResource, buildHostShellArgs: args => args },
  );

  // 1. Stock package-manager rejections MUST NOT be bypassed even when leading command is an interpreter flag.
  for (const pkgCommand of [
    'bash -lc "npm test"',
    'sh -c "pnpm build"',
    'node -v && npm run x',
    'python3 -c 1; yarn build',
  ]) {
    const res = await wrapped({}, { resourceAccessor: accessor, command: pkgCommand, workingDirectory: '/workspace', toolCallId: 'pkg' });
    assert.equal(res?.kind, 'package_script_unresolved', `Expected stock package_script_unresolved for: ${pkgCommand}`);
    assert.equal(res?.approval_binding_unavailable, true);
  }

  // 2. Interpreter flags clear stock's bogus `<working_directory>/<flag>` executable result.
  stockCalls = [];
  assert.equal(await wrapped({}, { resourceAccessor: accessor, command: 'node -v', workingDirectory: '/workspace', toolCallId: 't1' }), undefined);
  assert.equal(await wrapped({}, { resourceAccessor: accessor, command: 'python3 -c "print(1)"', workingDirectory: '/workspace', toolCallId: 't2' }), undefined);
  assert.equal(stockCalls.length, 2);

  // 3. Unseen-file flags / redirects keep stock's unavailable marker intact.
  const preloadRes = await wrapped({}, { resourceAccessor: accessor, command: 'node -r ./preload.js -e "1"', workingDirectory: '/workspace', toolCallId: 't2b' });
  assert.equal(preloadRes?.approval_binding_unavailable, true);
  assert.equal(preloadRes?.path, '/workspace/-r');

  // 4. Flag before script resolves script and reuses stock fast-path for small scripts.
  const smallBound = await wrapped({}, { resourceAccessor: accessor, command: 'python3 -u ./small.py', workingDirectory: '/workspace', toolCallId: 't3' });
  assert.equal(smallBound.kind, 'executable');
  assert.equal(smallBound.truncated, false);
  assert.equal(smallBound.approval_binding_unavailable, undefined);

  // 5. Large text script (>200 lines) binds deterministically with full SHA-256 and preview, and detects tampering.
  const bigBound1 = await wrapped({}, { resourceAccessor: accessor, command: `python3 ${bigScriptPosix}`, workingDirectory: '/workspace', toolCallId: 't4' });
  assert.equal(bigBound1.kind, 'executable');
  assert.equal(bigBound1.approval_binding_unavailable, undefined);
  assert.equal(bigBound1.truncated, true);
  assert.equal(bigBound1.definition_hash, createHash('sha256').update(bigScriptBody).digest('hex'));

  await writeFile(bigScriptReal, bigScriptBody + 'print("tampered")\n', 'utf8');
  const bigBoundTampered = await wrapped({}, { resourceAccessor: accessor, command: `python3 ${bigScriptPosix}`, workingDirectory: '/workspace', toolCallId: 't5' });
  assert.notEqual(bigBoundTampered.definition_hash, bigBound1.definition_hash);

  // 6. Compiled ELF binary binds deterministically as binary_executable.
  const elfBound = await wrapped({}, {
    resourceAccessor: accessor,
    command: `HOME=/workspace/.toolhome ${elfPosix} --status --output-format text`,
    workingDirectory: '/workspace',
    toolCallId: 't6',
  });
  assert.equal(elfBound.kind, 'binary_executable');
  assert.equal(elfBound.format, 'elf');
  assert.equal(elfBound.size_bytes, elfBytes.length);
  assert.equal(elfBound.definition_hash, createHash('sha256').update(elfBytes).digest('hex'));
  assert.equal(elfBound.hash_scope, 'full-sha256');
  assert.equal(elfBound.approval_binding_unavailable, undefined);

  // 7. Files exceeding fullHashMaxBytes fail closed instead of falling back to partial stat hashing.
  const wrappedTinyMax = wrapSandShellAutoReviewTargetEnrichment(
    async () => ({ kind: 'executable', path: elfPosix, approval_binding_unavailable: true, approval_binding_nonce: 'n' }),
    { shellExecutorResource, buildHostShellArgs: args => args, fullHashMaxBytes: 128 },
  );
  const oversized = await wrappedTinyMax({}, { resourceAccessor: accessor, command: `${elfPosix} --version`, workingDirectory: '/workspace', toolCallId: 't7' });
  assert.equal(oversized.approval_binding_unavailable, true);

  // 8. Script with single quote in filename after flags binds (and missing fails closed).
  const quotedBound = await wrapped({}, {
    resourceAccessor: accessor,
    command: `python3 -u "it's a script.py"`,
    workingDirectory: '/workspace',
    toolCallId: 't8',
  });
  assert.equal(quotedBound.kind, 'executable');
  assert.equal(quotedBound.path, quotedPosix);
  assert.equal(quotedBound.approval_binding_unavailable, undefined);

  const missingAfterFlag = await wrapped({}, {
    resourceAccessor: accessor,
    command: `python3 -u "no'such.py"`,
    workingDirectory: '/workspace',
    toolCallId: 't9',
  });
  assert.equal(missingAfterFlag.approval_binding_unavailable, true);

  // 9. Reject paths containing NUL bytes and invalid fullHashMaxBytes.
  assert.throws(() => buildExecutableProbeCommand('/tmp/bad\0path'), /Invalid executable path/);
  assert.throws(() => buildExecutableProbeCommand('/tmp/ok', { fullHashMaxBytes: 0 }), /Invalid fullHashMaxBytes/);
});

test('wrapSandShellAutoReviewTargetEnrichment never binds same-named harmless decoy files for flag values or disallowed flags', async () => {
  // Simulate a workspace where the Bot planted harmless decoy files matching flag values
  // alongside real target scripts, so any misbinding would return a valid-looking stock enrichment.
  const workspaceFiles = new Map([
    ['/workspace/strict', 'console.log("harmless strict");\n'],
    ['/workspace/extglob', 'echo "harmless extglob"\n'],
    ['/workspace/ignore', 'print("harmless ignore")\n'],
    ['/workspace/dev', 'print("harmless dev")\n'],
    ['/workspace/build', 'console.log("harmless build");\n'],
    ['/workspace/spec', 'console.log("harmless spec");\n'],
    ['/workspace/100', 'console.log("harmless 100");\n'],
    ['/workspace/decoy', 'console.log("harmless decoy");\n'],
    ['/workspace/evil.js', 'require("node:child_process").execSync("id");\n'],
    ['/workspace/evil.sh', 'id\n'],
    ['/workspace/evil.py', 'import os; os.system("id")\n'],
  ]);

  const wrapped = wrapSandShellAutoReviewTargetEnrichment(async (_ctx, args) => {
    const stripped = args.command.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)+/, '');
    const parts = stripped.trim().split(/\s+/);
    if (parts.length >= 2 && /^(python3|node|bash|sh|zsh)$/.test(parts[0])) {
      const candidate = parts[1].replace(/^['"]|['"]$/g, '');
      const resolved = candidate.startsWith('/') ? candidate : path.posix.resolve(args.workingDirectory ?? '/', candidate);
      if (workspaceFiles.has(resolved)) {
        const content = workspaceFiles.get(resolved);
        return {
          kind: 'executable',
          path: resolved,
          definition: content,
          definition_hash: createHash('sha256').update(content).digest('hex'),
          truncated: false,
        };
      }
      return {
        kind: 'executable',
        path: resolved,
        approval_binding_unavailable: true,
        approval_binding_nonce: 'nonce-stock',
      };
    }
    return undefined;
  });

  // Allowlisted value flags skip their value (even when a same-named decoy exists) and bind the real script.
  for (const [command, expectedPath] of [
    ['python3 -uW ignore evil.py', '/workspace/evil.py'],
    ['python3 -uX dev evil.py', '/workspace/evil.py'],
    ['bash -O extglob evil.sh', '/workspace/evil.sh'],
    ['bash +O extglob evil.sh', '/workspace/evil.sh'],
    ['node --unhandled-rejections strict evil.js', '/workspace/evil.js'],
  ]) {
    const res = await wrapped({}, { command, workingDirectory: '/workspace', toolCallId: 'allow-val' });
    assert.equal(res?.kind, 'executable', `Expected bound executable for: ${command}`);
    assert.equal(res?.path, expectedPath, `Must bind real script instead of decoy for: ${command}`);
    assert.equal(res?.definition, workspaceFiles.get(expectedPath));
    assert.equal(res?.approval_binding_unavailable, undefined);
  }

  // Disallowed / unknown flags and dangerous env prefixes must keep stock approval_binding_unavailable
  // rather than binding a same-named decoy file or clearing enrichment to undefined.
  for (const command of [
    'node --run build',
    'node --test',
    'node --test --test-reporter spec',
    'node --test-reporter=./x.mjs --test',
    'node --stack-size 100 evil.js',
    'node --experimental-config-file=x.json -e 1',
    'node --experimental-default-config-file -e 1',
    'node --openssl-config=./x.cnf -e 1',
    'node -e "1" -r ./preload.js',
    'node --unknown-flag decoy evil.js',
    'bash --unknown-flag decoy evil.sh',
    'python3 --unknown-flag decoy evil.py',
    'NODE_OPTIONS="--require ./x.js" node -e 1',
    'BASH_ENV=./x.sh bash -c true',
    'LD_PRELOAD=./x.so python3 -c 1',
  ]) {
    const res = await wrapped({}, { command, workingDirectory: '/workspace', toolCallId: 'deny-decoy' });
    assert.equal(res?.approval_binding_unavailable, true, `Expected stock unavailable for: ${command}`);
    assert.equal(workspaceFiles.has(res?.path), false, `Must never bind a decoy file for: ${command}`);
  }
});

test('POSIX probe command executes cleanly in isolated /usr/bin:/bin environment', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shell-auto-review-posix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const elfPath = path.join(dir, 'demo-cli');
  const elfBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(512, 0x42)]);
  await writeFile(elfPath, elfBytes);
  await chmod(elfPath, 0o755);

  const linkPath = path.join(dir, 'demo-cli-link');
  await symlink(elfPath, linkPath);

  const subDirPath = path.join(dir, 'subdir');
  await mkdir(subDirPath);

  // Put a poisoned `sha256sum` / `shasum` on caller PATH to prove the probe ignores it.
  const evilBin = path.join(dir, 'evil-bin');
  await mkdir(evilBin);
  const decoyHasher = path.join(evilBin, 'sha256sum');
  await writeFile(decoyHasher, '#!/bin/sh\necho "0000000000000000000000000000000000000000000000000000000000000000  -"\n');
  await chmod(decoyHasher, 0o755);

  const shellExecutorResource = Symbol('shellExecutor');
  const accessor = {
    get() {
      return {
        async execute(_ctx, args) {
          try {
            const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', args.command], {
              cwd: args.workingDirectory,
              env: { ...process.env, PATH: `${evilBin}:${process.env.PATH ?? ''}` },
            });
            return { result: { case: 'success', value: { exitCode: 0, stdout, stderr } } };
          } catch (error) {
            return {
              result: {
                case: 'failure',
                value: {
                  aborted: false,
                  exitCode: typeof error.code === 'number' ? error.code : 1,
                  stdout: error.stdout ?? '',
                  stderr: error.stderr ?? '',
                },
              },
            };
          }
        },
      };
    },
  };

  const wrapped = wrapSandShellAutoReviewTargetEnrichment(
    async (_ctx, args) => {
      const m = /(\/[^\s'"]+)/.exec(args.command);
      return { kind: 'executable', path: m ? m[1] : path.join(dir, 'missing.sh'), approval_binding_unavailable: true, approval_binding_nonce: 'n' };
    },
    { shellExecutorResource, buildHostShellArgs: args => args },
  );

  const elfBound = await wrapped({}, { resourceAccessor: accessor, command: `${linkPath} --status`, workingDirectory: dir, toolCallId: 'p1' });
  assert.equal(elfBound.kind, 'binary_executable');
  assert.equal(elfBound.definition_hash, createHash('sha256').update(elfBytes).digest('hex'));

  const dirAttempt = await wrapped({}, { resourceAccessor: accessor, command: subDirPath, workingDirectory: dir, toolCallId: 'p2' });
  assert.equal(dirAttempt.approval_binding_unavailable, true);
});

test('enhancePromptToolsBindings wraps enrichment and validates GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS', () => {
  const warnings = [];
  assert.equal(readAutoReviewClassifierMaxAttempts({}, DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS, { log: m => warnings.push(m) }), 2);
  assert.equal(readAutoReviewClassifierMaxAttempts({ GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS: '3' }, 2, { log: m => warnings.push(m) }), 3);
  assert.equal(warnings.length, 0);

  for (const invalid of ['0', '99', '0x2', '2.0', 'abc']) {
    assert.equal(
      readAutoReviewClassifierMaxAttempts({ GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS: invalid }, 2, { log: m => warnings.push(m) }),
      2,
    );
  }
  assert.equal(warnings.length, 5);

  const originalFn = async () => undefined;
  const enhanced = enhancePromptToolsBindings(
    {
      buildSandShellAutoReviewTargetEnrichment: originalFn,
      SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS: 1,
      shellExecutorResource: Symbol('shell'),
    },
    { buildHostShellArgs: args => args },
    {},
  );
  assert.notEqual(enhanced.buildSandShellAutoReviewTargetEnrichment, originalFn);
  assert.equal(enhanced.SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS, 2);

  const overridden = enhancePromptToolsBindings(
    {
      buildSandShellAutoReviewTargetEnrichment: originalFn,
      SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS: 1,
    },
    {},
    { GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS: '1' },
  );
  assert.equal(overridden.SAND_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS, 1);
});

test('compose templates forward GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS to the host container', async () => {
  const releaseDir = path.resolve(import.meta.dirname, '../release');
  for (const filename of ['compose.yaml', 'compose.host.yaml']) {
    const body = await readFile(path.join(releaseDir, filename), 'utf8');
    assert.match(body, /GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS:\s*\$\{GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS:-\}/);
  }
});
