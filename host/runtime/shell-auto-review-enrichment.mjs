import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const SHELL_ENRICHMENT_PREVIEW_MAX_CHARS = 8_000;
export const SHELL_ENRICHMENT_PREVIEW_MAX_LINES = 200;
export const SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = 2;

const INTERPRETER_PATTERN = /^(python(?:3(?:\.\d+)?)?|node|bash|sh|zsh)(?=\s|$)/;

const PYTHON_INLINE_FLAGS = new Set(['-c', '-V', '--version', '-h', '--help']);
const PYTHON_VALUE_FLAGS = new Set(['-W', '-X', '--check-hash-based-pycs']);

const NODE_INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-v', '--version', '-h', '--help']);
const NODE_UNSEEN_FILE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '--env-file', '--env-file-if-exists',
]);
const NODE_VALUE_FLAGS = new Set([
  '-C', '--conditions',
  '--max-old-space-size', '--test-name-pattern', '--input-type',
  '--diagnostic-dir', '--redirect-warnings', '--title',
]);

const SHELL_INLINE_FLAGS = new Set(['-c', '--version', '--help']);
const SHELL_UNSEEN_FILE_FLAGS = new Set(['--rcfile', '--init-file']);
const SHELL_VALUE_FLAGS = new Set(['-o', '+o']);

export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function unquote(token) {
  if (
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/** Strip up to four env / `cd <dir> &&` prefixes matching stock sand-shell-auto-review-enrichment. */
export function stripShellPrefixes(command, workingDirectory) {
  let candidateCommand = String(command ?? '').trim();
  let candidateWorkingDirectory = workingDirectory;
  for (let prefixCount = 0; prefixCount < 4; prefixCount += 1) {
    const environmentPrefix = candidateCommand.match(
      /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)+/,
    );
    if (environmentPrefix !== null) {
      candidateCommand = candidateCommand.slice(environmentPrefix[0].length);
      continue;
    }
    const changeDirectoryPrefix = candidateCommand.match(
      /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*(.+)$/s,
    );
    if (changeDirectoryPrefix === null) break;
    const target = unquote(changeDirectoryPrefix[1]);
    if (candidateWorkingDirectory !== undefined) {
      candidateWorkingDirectory = path.posix.resolve(candidateWorkingDirectory, target);
    } else if (path.posix.isAbsolute(target)) {
      candidateWorkingDirectory = path.posix.resolve(target);
    }
    candidateCommand = changeDirectoryPrefix[2].trim();
  }
  return { command: candidateCommand, workingDirectory: candidateWorkingDirectory };
}

/**
 * Tokenize the first simple command segment (stopping at unquoted separators/redirections)
 * and detect whether stdin is redirected from an external file (`< file`, excluding `<<`/`<<<`).
 */
function tokenizeFirstSegment(command) {
  const tokens = [];
  const rawTokens = [];
  let current = '';
  let rawCurrent = '';
  let quote = null;
  let escaping = false;
  let hasToken = false;
  let hasFileInputRedirect = false;

  const flushToken = () => {
    if (!hasToken) return;
    tokens.push(current);
    rawTokens.push(rawCurrent);
    current = '';
    rawCurrent = '';
    hasToken = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaping) {
      current += ch;
      rawCurrent += ch;
      hasToken = true;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      rawCurrent += ch;
      if (ch === "'") quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (quote === '"') {
      rawCurrent += ch;
      if (ch === '"') quote = null;
      else if (ch === '\\' && index + 1 < command.length) {
        escaping = true;
      } else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === '\\') {
      rawCurrent += ch;
      escaping = true;
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      rawCurrent += ch;
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === '<') {
      if (command[index + 1] !== '<') {
        hasFileInputRedirect = true;
      }
      break;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '>') {
      break;
    }
    if (/\s/.test(ch)) {
      flushToken();
      continue;
    }
    current += ch;
    rawCurrent += ch;
    hasToken = true;
  }
  flushToken();
  return { tokens, rawTokens, hasFileInputRedirect };
}

function hasFlagWithEquals(token, flagSet) {
  const eq = token.indexOf('=');
  return eq > 0 && flagSet.has(token.slice(0, eq));
}

/**
 * Inspect interpreter invocations (python/node/bash/sh/zsh) so inline/version flags such as
 * `-v`, `-V`, `-c`, `-e`, `-lc`, or inline `-` (heredoc/stdin without `< file`) are not
 * misparsed as script paths on disk, while real script arguments after safe flags (e.g.
 * `python3 -u foo.py`) resolve to the target script path. Flags or redirections that load
 * unseen external files (`-r`, `--require`, `--import`, `--loader`, `--experimental-loader`,
 * `--env-file`, `--rcfile`, `--init-file`, `python3 -m`, `sh -s < file`, `bash < file`)
 * return `null` so the stock enrichment decision is preserved unchanged.
 */
export function parseInterpreterInvocation(command, workingDirectory) {
  const stripped = stripShellPrefixes(command, workingDirectory);
  if (!stripped.command) return null;
  const match = stripped.command.match(INTERPRETER_PATTERN);
  if (!match) return null;

  const interpreter = match[1];
  const { tokens, rawTokens, hasFileInputRedirect } = tokenizeFirstSegment(stripped.command);
  if (tokens.length < 2) return null;

  const firstArg = tokens[1];
  const rawFirstArg = rawTokens[1];
  const firstArgIsFlag = firstArg === '-' || firstArg.startsWith('-') ||
    ((interpreter === 'bash' || interpreter === 'sh' || interpreter === 'zsh') && firstArg.startsWith('+'));
  if (!firstArgIsFlag) {
    // Stock enrichment already parses direct script paths like `python3 foo.py`.
    return null;
  }

  const isPython = interpreter.startsWith('python');
  const isNode = interpreter === 'node';
  const isShell = interpreter === 'bash' || interpreter === 'sh' || interpreter === 'zsh';

  const resultMeta = {
    interpreter,
    firstArg,
    rawFirstArg,
    workingDirectory: stripped.workingDirectory,
  };

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-') {
      return hasFileInputRedirect ? null : { kind: 'no-script-file', ...resultMeta };
    }
    if (isPython) {
      if (token.startsWith('-W') || token.startsWith('-X')) {
        index += token.length === 2 ? 2 : 1;
        continue;
      }
      if (PYTHON_VALUE_FLAGS.has(token) || hasFlagWithEquals(token, PYTHON_VALUE_FLAGS)) {
        index += PYTHON_VALUE_FLAGS.has(token) ? 2 : 1;
        continue;
      }
      if (
        token === '-m' ||
        token.startsWith('-m') ||
        (/^-[A-Za-z]+$/.test(token) && token.slice(1).includes('m'))
      ) {
        return null;
      }
      if (PYTHON_INLINE_FLAGS.has(token) || token.startsWith('-c')) {
        return { kind: 'no-script-file', ...resultMeta };
      }
      if (/^-[A-Za-z]+$/.test(token) && /[cVh]/.test(token.slice(1))) {
        return { kind: 'no-script-file', ...resultMeta };
      }
      if (token.startsWith('-')) {
        index += 1;
        continue;
      }
      break;
    }
    if (isNode) {
      if (NODE_UNSEEN_FILE_FLAGS.has(token) || hasFlagWithEquals(token, NODE_UNSEEN_FILE_FLAGS)) {
        return null;
      }
      if (NODE_INLINE_FLAGS.has(token) || token.startsWith('--eval=') || token.startsWith('--print=')) {
        return { kind: 'no-script-file', ...resultMeta };
      }
      if (NODE_VALUE_FLAGS.has(token)) {
        index += 2;
        continue;
      }
      if (token.startsWith('-')) {
        index += 1;
        continue;
      }
      break;
    }
    if (isShell) {
      if (SHELL_UNSEEN_FILE_FLAGS.has(token) || hasFlagWithEquals(token, SHELL_UNSEEN_FILE_FLAGS)) {
        return null;
      }
      if (SHELL_INLINE_FLAGS.has(token)) {
        return { kind: 'no-script-file', ...resultMeta };
      }
      if (token === '-s' || (/^-[A-Za-z]+$/.test(token) && token.slice(1).includes('s'))) {
        return hasFileInputRedirect ? null : { kind: 'no-script-file', ...resultMeta };
      }
      if (/^-[A-Za-z]+$/.test(token) && token.slice(1).includes('c')) {
        return { kind: 'no-script-file', ...resultMeta };
      }
      if (SHELL_VALUE_FLAGS.has(token) || /^[-+][A-Za-z]*o$/.test(token)) {
        index += 2;
        continue;
      }
      if (token.startsWith('-') || token.startsWith('+')) {
        index += 1;
        continue;
      }
      break;
    }
    break;
  }

  if (index >= tokens.length) {
    return hasFileInputRedirect ? null : { kind: 'no-script-file', ...resultMeta };
  }
  if (tokens[index] === '-') {
    return hasFileInputRedirect ? null : { kind: 'no-script-file', ...resultMeta };
  }
  const scriptToken = tokens[index];
  if (path.posix.isAbsolute(scriptToken)) {
    return { kind: 'script-after-flags', ...resultMeta, path: scriptToken };
  }
  if (stripped.workingDirectory === undefined) {
    return null;
  }
  return {
    kind: 'script-after-flags',
    ...resultMeta,
    path: path.posix.resolve(stripped.workingDirectory, scriptToken),
  };
}

function isInterpreterFirstFlagPath(stockPath, workingDirectory, firstArg, rawFirstArg) {
  if (typeof stockPath !== 'string' || typeof workingDirectory !== 'string') return false;
  const resolvedStock = path.posix.resolve(stockPath);
  if (typeof firstArg === 'string' && resolvedStock === path.posix.resolve(workingDirectory, firstArg)) {
    return true;
  }
  if (typeof rawFirstArg === 'string' && resolvedStock === path.posix.resolve(workingDirectory, rawFirstArg)) {
    return true;
  }
  return false;
}

export function detectBinaryFormat(sample) {
  if (!Buffer.isBuffer(sample) || sample.length === 0) return null;
  if (sample.length >= 4 && sample[0] === 0x7f && sample[1] === 0x45 && sample[2] === 0x4c && sample[3] === 0x46) {
    return 'elf';
  }
  if (sample.length >= 4) {
    const magic = sample.readUInt32BE(0);
    if (
      magic === 0xfeedface || magic === 0xcefaedfe ||
      magic === 0xfeedfacf || magic === 0xcffaedfe ||
      magic === 0xcafebabe || magic === 0xbebafeca
    ) {
      return 'macho';
    }
  }
  const hasNul = sample.includes(0);
  if (sample.length >= 2 && sample[0] === 0x4d && sample[1] === 0x5a && hasNul) {
    return 'pe';
  }
  if (hasNul) return 'binary';
  return null;
}

export function buildExecutableProbeCommand(
  targetPath,
  { fullHashMaxBytes = SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES } = {},
) {
  if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.includes('\0')) {
    throw new Error('Invalid executable path for auto-review binding');
  }
  if (!Number.isSafeInteger(fullHashMaxBytes) || fullHashMaxBytes <= 0) {
    throw new Error('Invalid fullHashMaxBytes for auto-review binding');
  }
  const innerScript =
    'p="$1"; ' +
    '[ -f "$p" ] && [ -r "$p" ] || exit 2; ' +
    'st="$(stat -L -c \'%d:%i:%s:%Y:%Z:%a\' "$p" 2>/dev/null || stat -L -f \'%d:%i:%z:%m:%c:%Lp\' "$p" 2>/dev/null)" || exit 3; ' +
    'sz="$(printf \'%s\' "$st" | cut -d: -f3)"; ' +
    'case "$sz" in \'\'|*[!0-9]*) exit 3 ;; esac; ' +
    `[ "$sz" -le ${fullHashMaxBytes} ] || exit 5; ` +
    'hasher() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk \'{print $1}\'; ' +
    'elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk \'{print $1}\'; ' +
    'else openssl dgst -sha256 -r | awk \'{print $1}\'; fi; }; ' +
    'h="$(hasher < "$p")" || exit 4; ' +
    `b64="$(head -c ${SHELL_ENRICHMENT_PREVIEW_MAX_CHARS} "$p" | base64 | tr -d '\\r\\n')"; ` +
    'printf \'stat=%s\\nsize=%s\\nscope=full-sha256\\nsha256=%s\\nhead_b64=%s\\n\' "$st" "$sz" "$h" "$b64"';
  return `/usr/bin/env -i PATH=/usr/bin:/bin /bin/sh -c ${shellSingleQuote(innerScript)} _ ${shellSingleQuote(targetPath)}`;
}

export function parseExecutableProbeOutput(stdout, targetPath) {
  const fields = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const sizeRaw = fields.get('size');
  const scope = fields.get('scope');
  const sha256 = fields.get('sha256');
  const headB64 = fields.get('head_b64') ?? '';
  if (!sizeRaw || !/^\d+$/.test(sizeRaw)) return undefined;
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) return undefined;
  if (scope !== 'full-sha256') return undefined;

  const sizeBytes = Number.parseInt(sizeRaw, 10);
  const sample = headB64 ? Buffer.from(headB64, 'base64') : Buffer.alloc(0);
  const binaryFormat = detectBinaryFormat(sample);
  if (binaryFormat !== null) {
    return {
      kind: 'binary_executable',
      path: targetPath,
      format: binaryFormat,
      size_bytes: sizeBytes,
      definition_hash: sha256.toLowerCase(),
      hash_scope: scope,
      truncated: true,
    };
  }

  const rawText = sample.toString('utf8');
  const lines = rawText.split('\n');
  const clippedByLines = lines.length > SHELL_ENRICHMENT_PREVIEW_MAX_LINES;
  const preview = (clippedByLines ? lines.slice(0, SHELL_ENRICHMENT_PREVIEW_MAX_LINES).join('\n') : rawText)
    .slice(0, SHELL_ENRICHMENT_PREVIEW_MAX_CHARS);
  const truncated = sizeBytes > sample.length || clippedByLines || rawText.length > SHELL_ENRICHMENT_PREVIEW_MAX_CHARS;

  return {
    kind: 'executable',
    path: targetPath,
    definition: preview,
    definition_hash: sha256.toLowerCase(),
    truncated,
  };
}

function extractShellExit(result) {
  const shell = result?.result;
  if (!shell) return undefined;
  if (shell.case === 'success' && shell.value && typeof shell.value.exitCode === 'number') return shell.value;
  if (shell.case === 'failure' && !shell.value?.aborted && typeof shell.value?.exitCode === 'number') return shell.value;
  return undefined;
}

async function probeExecutableBinding(ctx, { resourceAccessor, targetPath, workingDirectory, toolCallId }, deps) {
  if (!deps?.shellExecutorResource || typeof deps?.buildHostShellArgs !== 'function') return undefined;
  let shellExecutor;
  try {
    shellExecutor = resourceAccessor?.get?.(deps.shellExecutorResource);
  } catch {
    return undefined;
  }
  if (!shellExecutor || typeof shellExecutor.execute !== 'function') return undefined;
  try {
    const command = buildExecutableProbeCommand(targetPath, {
      fullHashMaxBytes: deps.fullHashMaxBytes ?? SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES,
    });
    const result = await shellExecutor.execute(
      ctx,
      deps.buildHostShellArgs({
        command,
        name: 'auto-review-bind',
        workingDirectory: workingDirectory ?? '/',
        toolCallId: `${toolCallId || 'shell'}-bind`,
      }),
    );
    const exited = extractShellExit(result);
    if (!exited || exited.exitCode !== 0) return undefined;
    return parseExecutableProbeOutput(exited.stdout, targetPath);
  } catch {
    return undefined;
  }
}

export function readAutoReviewClassifierMaxAttempts(
  env = process.env,
  fallback = DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS,
  { log = message => console.warn(message) } = {},
) {
  const raw = env?.GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS;
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    log(`[auto-review] ignoring invalid GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS=${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (parsed < 1 || parsed > 5) {
    log(`[auto-review] ignoring out-of-range GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS=${raw.trim()} (expected 1-5); using ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * Wrap the stock Shell auto-review target enrichment so:
 * 1. Stock enrichment runs first; only when stock returns `kind: "executable"` with
 *    `approval_binding_unavailable` and `path` matching `working_directory + <firstFlag>`
 *    do we clear inline/version flags (`node -v`, `python3 -c`, `bash -lc`) or re-bind
 *    scripts after safe flags (`python3 -u script.py`);
 * 2. Large text scripts (>200 lines / >8 KiB) and compiled binaries (ELF/Mach-O/PE) up to
 *    256 MiB bind deterministically by full-file SHA-256 so user approvals remain TOCTOU-bound
 *    (while the local classifier blocks them for user confirmation rather than auto-allowing);
 * 3. Files exceeding 256 MiB and missing/unreadable/non-regular paths keep the stock
 *    `approval_binding_unavailable` result (fail closed).
 */
export function wrapSandShellAutoReviewTargetEnrichment(originalEnrich, deps = {}) {
  if (typeof originalEnrich !== 'function') return originalEnrich;
  return async function enhancedSandShellAutoReviewTargetEnrichment(ctx, args) {
    const stock = await originalEnrich(ctx, args);
    const interpreterTarget = parseInterpreterInvocation(args?.command, args?.workingDirectory);
    if (
      interpreterTarget &&
      stock?.kind === 'executable' &&
      stock.approval_binding_unavailable === true &&
      isInterpreterFirstFlagPath(
        stock.path,
        interpreterTarget.workingDirectory,
        interpreterTarget.firstArg,
        interpreterTarget.rawFirstArg,
      )
    ) {
      if (interpreterTarget.kind === 'no-script-file') {
        return undefined;
      }
      if (interpreterTarget.kind === 'script-after-flags') {
        const targetPath = interpreterTarget.path;
        if (!targetPath.includes("'")) {
          const stockAfterFlags = await originalEnrich(ctx, {
            ...args,
            command: `${interpreterTarget.interpreter} '${targetPath}'`,
          });
          if (stockAfterFlags && stockAfterFlags.approval_binding_unavailable !== true) {
            return stockAfterFlags;
          }
        }
        const boundAfterFlags = await probeExecutableBinding(
          ctx,
          {
            resourceAccessor: args?.resourceAccessor,
            targetPath,
            workingDirectory: args?.workingDirectory,
            toolCallId: args?.toolCallId,
          },
          deps,
        );
        return boundAfterFlags ?? {
          kind: 'executable',
          path: targetPath,
          approval_binding_unavailable: true,
          approval_binding_nonce: randomUUID(),
        };
      }
    }

    if (
      !stock ||
      stock.approval_binding_unavailable !== true ||
      stock.kind !== 'executable' ||
      typeof stock.path !== 'string' ||
      stock.path.length === 0
    ) {
      return stock;
    }

    const bound = await probeExecutableBinding(
      ctx,
      {
        resourceAccessor: args?.resourceAccessor,
        targetPath: stock.path,
        workingDirectory: args?.workingDirectory,
        toolCallId: args?.toolCallId,
      },
      deps,
    );
    return bound ?? stock;
  };
}
