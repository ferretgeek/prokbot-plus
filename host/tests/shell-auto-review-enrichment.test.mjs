import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { enhancePromptToolsBindings } from '../runtime/recovered-prompt-tools.mjs';
import {
  DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
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

test('parseInterpreterInvocation skips inline and version flags while resolving scripts after flags', () => {
  // Flags/inline/stdin modes must never be mistaken for script filenames when workingDirectory is set.
  for (const command of [
    'node -v',
    'node --version',
    'node -e "console.log(1)"',
    'node --eval="console.log(1)"',
    'node -p "1+1"',
    'python3 -V',
    'python3 --version',
    'python3 -c "print(1)"',
    'python3 -c"print(1)"',
    'python3 -uc "print(1)"',
    'python3 -m json.tool',
    'python3 -mhttp.server',
    'python3 - <<\'PY\'\nprint(1)\nPY',
    'bash -lc "ls -la"',
    'bash -lc "npm test"',
    'sh -c "pnpm build"',
    'sh -c "echo hi"',
    'zsh -s',
    'cd /workspace/work && HOME=/workspace/.toolhome python3 -c "print(1)"',
    'env NODE_ENV=test node -v',
  ]) {
    const parsed = parseInterpreterInvocation(command, '/workspace');
    assert.equal(parsed?.kind, 'no-script-file', `Expected no-script-file for: ${command}`);
  }

  // Real scripts after option flags still resolve to the actual script path.
  assert.deepEqual(
    parseInterpreterInvocation('python3 -u ./scripts/report.py --flag', '/workspace'),
    { kind: 'script-after-flags', interpreter: 'python3', path: '/workspace/scripts/report.py' },
  );
  assert.deepEqual(
    parseInterpreterInvocation('python3 -W ignore /workspace/tools/check.py', '/workspace'),
    { kind: 'script-after-flags', interpreter: 'python3', path: '/workspace/tools/check.py' },
  );
  assert.deepEqual(
    parseInterpreterInvocation('python3 -Wonce -Xtracemalloc ./scripts/report.py', '/workspace'),
    { kind: 'script-after-flags', interpreter: 'python3', path: '/workspace/scripts/report.py' },
  );
  assert.deepEqual(
    parseInterpreterInvocation('node --no-warnings --env-file .env scripts/run.mjs', '/workspace'),
    { kind: 'script-after-flags', interpreter: 'node', path: '/workspace/scripts/run.mjs' },
  );
  assert.deepEqual(
    parseInterpreterInvocation('bash -euo pipefail ./deploy.sh --dry-run', '/workspace'),
    { kind: 'script-after-flags', interpreter: 'bash', path: '/workspace/deploy.sh' },
  );

  // Direct script invocations without leading flags and package managers defer to stock logic.
  assert.equal(parseInterpreterInvocation('python3 ./script.py', '/workspace'), null);
  assert.equal(parseInterpreterInvocation('npm run build', '/workspace'), null);
  assert.equal(parseInterpreterInvocation('HOME=/workspace/.toolhome /workspace/bin/demo-cli --status', '/workspace'), null);
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
    `stat=1:2:278438600:1700000000:1700000000:755\nsize=278438600\nscope=stat-head-tail-64k\nsha256=${digest}\nhead_b64=${elfB64}\n`,
    '/workspace/bin/demo-cli',
  );
  assert.deepEqual(elfParsed, {
    kind: 'binary_executable',
    path: '/workspace/bin/demo-cli',
    format: 'elf',
    size_bytes: 278438600,
    definition_hash: digest,
    hash_scope: 'stat-head-tail-64k',
    truncated: true,
  });

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

test('wrapSandShellAutoReviewTargetEnrichment binds large text scripts and compiled binaries on POSIX while failing closed on missing files', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shell-auto-review-bind-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const bigScriptPath = path.join(dir, 'big_script.py');
  const bigScriptBody = Array.from({ length: 250 }, (_, i) => `print("step ${i + 1}")`).join('\n') + '\n';
  await writeFile(bigScriptPath, bigScriptBody, 'utf8');

  const elfPath = path.join(dir, 'demo-cli');
  const elfBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), Buffer.alloc(1024, 0x41)]);
  await writeFile(elfPath, elfBytes);
  await chmod(elfPath, 0o755);

  const linkPath = path.join(dir, 'demo-cli-link');
  await symlink(elfPath, linkPath);

  const subDirPath = path.join(dir, 'subdir');
  await mkdir(subDirPath);

  const shellExecutorResource = Symbol('shellExecutor');
  const accessor = {
    get(resource) {
      assert.equal(resource, shellExecutorResource);
      return {
        async execute(_ctx, args) {
          try {
            const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', args.command], { cwd: args.workingDirectory });
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

  let stockCalls = [];
  const wrapped = wrapSandShellAutoReviewTargetEnrichment(
    async (_ctx, args) => {
      stockCalls.push(args.command);
      if (args.command.includes('small.py')) {
        return { kind: 'executable', path: path.join(dir, 'small.py'), definition: 'print(1)', definition_hash: 'b'.repeat(64), truncated: false };
      }
      if (args.command.includes('npm run')) {
        return { kind: 'package_script_unresolved', invocation: args.command, approval_binding_unavailable: true };
      }
      const strippedCmd = args.command.replace(/^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '');
      const match = /(\/[^\s'"]+)/.exec(strippedCmd);
      return {
        kind: 'executable',
        path: match ? match[1] : path.join(dir, 'missing.sh'),
        approval_binding_unavailable: true,
        approval_binding_nonce: 'nonce-1',
      };
    },
    {
      shellExecutorResource,
      buildHostShellArgs: args => args,
    },
  );

  // 1. Interpreter flags return undefined without hitting stock enrichment at all
  stockCalls = [];
  assert.equal(await wrapped({}, { resourceAccessor: accessor, command: 'node -v', workingDirectory: dir, toolCallId: 't1' }), undefined);
  assert.equal(await wrapped({}, { resourceAccessor: accessor, command: 'python3 -c "print(1)"', workingDirectory: dir, toolCallId: 't2' }), undefined);
  assert.equal(stockCalls.length, 0);

  // 2. Flag before script resolves script and reuses stock fast-path for small scripts
  const smallBound = await wrapped({}, { resourceAccessor: accessor, command: 'python3 -u ./small.py', workingDirectory: dir, toolCallId: 't3' });
  assert.equal(smallBound.kind, 'executable');
  assert.equal(smallBound.truncated, false);
  assert.equal(smallBound.approval_binding_unavailable, undefined);

  // 3. Large text script (>200 lines) binds deterministically with full SHA-256 and preview
  const bigBound1 = await wrapped({}, { resourceAccessor: accessor, command: `python3 ${bigScriptPath}`, workingDirectory: dir, toolCallId: 't4' });
  const bigBound2 = await wrapped({}, { resourceAccessor: accessor, command: `python3 ${bigScriptPath}`, workingDirectory: dir, toolCallId: 't5' });
  assert.equal(bigBound1.kind, 'executable');
  assert.equal(bigBound1.approval_binding_unavailable, undefined);
  assert.equal(bigBound1.truncated, true);
  assert.equal(bigBound1.definition_hash, createHash('sha256').update(bigScriptBody).digest('hex'));
  assert.deepEqual(bigBound1, bigBound2);

  // 4. Compiled ELF binary (and symlink to it) binds deterministically as binary_executable
  const elfBound = await wrapped({}, {
    resourceAccessor: accessor,
    command: `HOME=/workspace/.toolhome ${linkPath} --status --output-format text`,
    workingDirectory: dir,
    toolCallId: 't6',
  });
  assert.equal(elfBound.kind, 'binary_executable');
  assert.equal(elfBound.format, 'elf');
  assert.equal(elfBound.size_bytes, elfBytes.length);
  assert.equal(elfBound.definition_hash, createHash('sha256').update(elfBytes).digest('hex'));
  assert.equal(elfBound.hash_scope, 'full-sha256');
  assert.equal(elfBound.approval_binding_unavailable, undefined);

  // 5. File mutation between review and execution changes definition_hash (TOCTOU protection)
  await writeFile(bigScriptPath, bigScriptBody + 'print("tampered")\n', 'utf8');
  const bigBoundAfterTamper = await wrapped({}, { resourceAccessor: accessor, command: `python3 ${bigScriptPath}`, workingDirectory: dir, toolCallId: 't7' });
  assert.notEqual(bigBoundAfterTamper.definition_hash, bigBound1.definition_hash);

  // 6. Missing file, directory, and unresolved package scripts still fail closed
  const missing = await wrapped({}, { resourceAccessor: accessor, command: `${path.join(dir, 'nope.sh')}`, workingDirectory: dir, toolCallId: 't8' });
  assert.equal(missing.approval_binding_unavailable, true);
  const dirAttempt = await wrapped({}, { resourceAccessor: accessor, command: `${subDirPath}`, workingDirectory: dir, toolCallId: 't9' });
  assert.equal(dirAttempt.approval_binding_unavailable, true);
  const pkgUnresolved = await wrapped({}, { resourceAccessor: accessor, command: 'npm run build', workingDirectory: dir, toolCallId: 't10' });
  assert.equal(pkgUnresolved.approval_binding_unavailable, true);

  // 7. Huge binary (>fullHashMaxBytes) binds deterministically via stat-head-tail-64k
  const wrappedBounded = wrapSandShellAutoReviewTargetEnrichment(
    async () => ({ kind: 'executable', path: elfPath, approval_binding_unavailable: true, approval_binding_nonce: 'n' }),
    {
      shellExecutorResource,
      buildHostShellArgs: args => args,
      fullHashMaxBytes: 128,
      boundedChunkBytes: 64,
    },
  );
  const bounded1 = await wrappedBounded({}, { resourceAccessor: accessor, command: `${elfPath} --version`, workingDirectory: dir, toolCallId: 't11' });
  const bounded2 = await wrappedBounded({}, { resourceAccessor: accessor, command: `${elfPath} --version`, workingDirectory: dir, toolCallId: 't12' });
  assert.equal(bounded1.kind, 'binary_executable');
  assert.equal(bounded1.format, 'elf');
  assert.equal(bounded1.hash_scope, 'stat-head-tail-64k');
  assert.equal(bounded1.size_bytes, elfBytes.length);
  assert.deepEqual(bounded1, bounded2);

  // 8. Script with single quote in filename after flags still binds (and fails closed if missing)
  const quotedPath = path.join(dir, "it's a script.py");
  await writeFile(quotedPath, 'print("quoted")\n', 'utf8');
  const quotedBound = await wrapped({}, {
    resourceAccessor: accessor,
    command: `python3 -u "it's a script.py"`,
    workingDirectory: dir,
    toolCallId: 't13',
  });
  assert.equal(quotedBound.kind, 'executable');
  assert.equal(quotedBound.path, quotedPath);
  assert.equal(quotedBound.approval_binding_unavailable, undefined);

  const missingAfterFlag = await wrapped({}, {
    resourceAccessor: accessor,
    command: `python3 -u "no'such.py"`,
    workingDirectory: dir,
    toolCallId: 't14',
  });
  assert.equal(missingAfterFlag.approval_binding_unavailable, true);

  // 9. Reject paths containing NUL bytes
  assert.throws(() => buildExecutableProbeCommand('/tmp/bad\0path'), /Invalid executable path/);
});

test('enhancePromptToolsBindings wraps enrichment and raises classifier max attempts with env override', () => {
  assert.equal(readAutoReviewClassifierMaxAttempts({}), DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS);
  assert.equal(readAutoReviewClassifierMaxAttempts({ GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS: '3' }), 3);
  assert.equal(readAutoReviewClassifierMaxAttempts({ GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS: '0' }), 2);
  assert.equal(readAutoReviewClassifierMaxAttempts({ GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS: '99' }), 2);

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
