import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const SHELL_ENRICHMENT_PREVIEW_MAX_CHARS = 8_000;
export const SHELL_ENRICHMENT_PREVIEW_MAX_LINES = 200;
export const SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = 2;

const INTERPRETER_PATTERN = /^(python(?:3(?:\.\d+)?)?|node|bash|sh|zsh)(?=\s|$)/;

const DANGEROUS_ENV_EXACT = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'OPENSSL_CONF',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'SHELLOPTS',
  'BASHOPTS',
]);
const ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+/;

function isDangerousEnvVar(name) {
  return (
    DANGEROUS_ENV_EXACT.has(name) ||
    name.startsWith('LD_') ||
    name.startsWith('DYLD_') ||
    name.startsWith('PYTHON') ||
    name.startsWith('BASH_FUNC_')
  );
}

// Strict allowlists per interpreter: any flag not listed here fails closed (returns null)
// so unknown value-taking flags or unseen-file loaders never misbind a decoy argument.
const PYTHON_BOOL_SHORT_FLAGS = new Set(['b', 'B', 'd', 'E', 'I', 'O', 'P', 'q', 's', 'S', 'u', 'v', 'x']);
const PYTHON_VALUE_SHORT_FLAGS = new Set(['W', 'X']);
const PYTHON_LONG_INLINE_FLAGS = new Set(['--version', '--help']);
const PYTHON_LONG_VALUE_FLAGS = new Set(['--check-hash-based-pycs']);

const NODE_INLINE_INFO_FLAGS = new Set(['-v', '--version', '-h', '--help']);
const NODE_INLINE_CODE_FLAGS = new Set(['-e', '-p', '-pe', '-ep', '--eval', '--print']);
const NODE_INLINE_CODE_EQUALS_FLAGS = new Set(['--eval', '--print']);
const NODE_BOOL_FLAGS = new Set([
  '-c', '--check',
  '--no-warnings', '--no-deprecation', '--throw-deprecation',
  '--trace-deprecation', '--trace-warnings', '--trace-uncaught',
  '--enable-source-maps',
  '--preserve-symlinks', '--preserve-symlinks-main',
  '--pending-deprecation',
  '--experimental-strip-types', '--no-experimental-strip-types',
  '--experimental-transform-types',
  '--no-experimental-detect-module',
  '--experimental-vm-modules',
  '--disallow-code-generation-from-strings',
  '--frozen-intrinsics',
  '--zero-fill-buffers',
]);
const NODE_OPTIONAL_EQUALS_FLAGS = new Set(['--inspect', '--inspect-brk', '--inspect-wait']);
const NODE_EQUALS_ONLY_VALUE_FLAGS = new Set(['--max-old-space-size', '--max-semi-space-size', '--stack-size']);
const NODE_VALUE_FLAGS = new Set([
  '-C', '--conditions',
  '--input-type',
  '--unhandled-rejections',
  '--dns-result-order',
  '--title',
  '--max-http-header-size',
]);

const SHELL_BOOL_SHORT_FLAGS = new Set(['a', 'C', 'e', 'f', 'h', 'l', 'm', 'n', 'p', 'u', 'v', 'x']);
const SHELL_LONG_INLINE_FLAGS = new Set(['--version', '--help']);
const SHELL_LONG_BOOL_FLAGS = new Set(['--login', '--noprofile', '--norc', '--posix', '--verbose']);
const SHELL_OPTION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

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
  const envNames = [];
  for (let prefixCount = 0; prefixCount < 4; prefixCount += 1) {
    let rest = candidateCommand;
    const leadingEnv = rest.match(/^env\s+/);
    if (leadingEnv !== null) {
      rest = rest.slice(leadingEnv[0].length);
    }
    const batchNames = [];
    while (true) {
      const assign = rest.match(ENV_ASSIGNMENT_PATTERN);
      if (assign === null) break;
      batchNames.push(assign[1]);
      rest = rest.slice(assign[0].length);
    }
    if (batchNames.length > 0) {
      envNames.push(...batchNames);
      candidateCommand = rest;
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
  return { command: candidateCommand, workingDirectory: candidateWorkingDirectory, envNames };
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
 * Inspect interpreter invocations (python/node/bash/sh/zsh) using strict per-interpreter
 * allowlists so safe inline/version flags (`-v`, `-V`, `-c`, `-e`, `-lc`, inline `-`
 * without `< file`) are not misparsed as script paths on disk, while real script arguments
 * after allowlisted flags (e.g. `python3 -uW ignore foo.py`, `bash -O extglob foo.sh`,
 * `node --unhandled-rejections strict foo.js`) resolve to the actual script path.
 * Any unrecognized/disallowed flag (e.g. `-r`, `--require`, `--import`, `--env-file`,
 * `--rcfile`, `--test`, `--run`, `--experimental-config-file`, `--openssl-config`,
 * `python3 -m`), file stdin redirection (`< file`), or dangerous loader env prefix
 * (`NODE_OPTIONS`, `BASH_ENV`, `ENV`, `LD_*`, `DYLD_*`, `PYTHON*`, etc.) returns `null`
 * so the stock enrichment decision is preserved unchanged.
 */
export function parseInterpreterInvocation(command, workingDirectory) {
  const stripped = stripShellPrefixes(command, workingDirectory);
  if (!stripped.command) return null;
  if (stripped.envNames.some(isDangerousEnvVar)) return null;
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
  let noScriptFile = false;
  let readsFromStdin = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-') {
      readsFromStdin = true;
      break;
    }
    if (isPython) {
      if (token.startsWith('--')) {
        if (PYTHON_LONG_INLINE_FLAGS.has(token)) {
          return { kind: 'no-script-file', ...resultMeta };
        }
        if (PYTHON_LONG_VALUE_FLAGS.has(token)) {
          if (index + 1 >= tokens.length) return null;
          index += 2;
          continue;
        }
        if (hasFlagWithEquals(token, PYTHON_LONG_VALUE_FLAGS)) {
          index += 1;
          continue;
        }
        return null;
      }
      if (token.startsWith('-') && token.length > 1) {
        let sawInlineCode = false;
        let sawVersionOrHelp = false;
        let consumedValue = false;
        for (let charIdx = 1; charIdx < token.length; charIdx += 1) {
          const ch = token[charIdx];
          if (ch === 'c') {
            sawInlineCode = true;
            break;
          }
          if (PYTHON_BOOL_SHORT_FLAGS.has(ch)) {
            continue;
          }
          if (ch === 'V' || ch === 'h') {
            sawVersionOrHelp = true;
            continue;
          }
          if (PYTHON_VALUE_SHORT_FLAGS.has(ch)) {
            if (charIdx + 1 < token.length) {
              index += 1;
            } else {
              if (index + 1 >= tokens.length) return null;
              index += 2;
            }
            consumedValue = true;
            break;
          }
          return null;
        }
        if (sawInlineCode || sawVersionOrHelp) {
          return { kind: 'no-script-file', ...resultMeta };
        }
        if (consumedValue) {
          continue;
        }
        index += 1;
        continue;
      }
      break;
    }
    if (isNode) {
      if (NODE_INLINE_INFO_FLAGS.has(token)) {
        noScriptFile = true;
        index += 1;
        continue;
      }
      if (NODE_INLINE_CODE_FLAGS.has(token)) {
        if (index + 1 >= tokens.length) return null;
        noScriptFile = true;
        index += 2;
        continue;
      }
      if (hasFlagWithEquals(token, NODE_INLINE_CODE_EQUALS_FLAGS)) {
        noScriptFile = true;
        index += 1;
        continue;
      }
      if (NODE_BOOL_FLAGS.has(token)) {
        index += 1;
        continue;
      }
      if (NODE_OPTIONAL_EQUALS_FLAGS.has(token) || hasFlagWithEquals(token, NODE_OPTIONAL_EQUALS_FLAGS)) {
        index += 1;
        continue;
      }
      if (hasFlagWithEquals(token, NODE_EQUALS_ONLY_VALUE_FLAGS)) {
        index += 1;
        continue;
      }
      if (NODE_VALUE_FLAGS.has(token)) {
        if (index + 1 >= tokens.length) return null;
        index += 2;
        continue;
      }
      if (token.startsWith('--') && hasFlagWithEquals(token, NODE_VALUE_FLAGS)) {
        index += 1;
        continue;
      }
      if (token.startsWith('-')) {
        return null;
      }
      break;
    }
    if (isShell) {
      if (token.startsWith('--')) {
        if (SHELL_LONG_INLINE_FLAGS.has(token)) {
          noScriptFile = true;
          index += 1;
          continue;
        }
        if (SHELL_LONG_BOOL_FLAGS.has(token)) {
          index += 1;
          continue;
        }
        return null;
      }
      if ((token.startsWith('-') || token.startsWith('+')) && token.length > 1) {
        const isMinus = token[0] === '-';
        let sawC = false;
        let valueArgsNeeded = 0;
        for (let charIdx = 1; charIdx < token.length; charIdx += 1) {
          const ch = token[charIdx];
          if (SHELL_BOOL_SHORT_FLAGS.has(ch)) {
            continue;
          }
          if (isMinus && ch === 'c') {
            sawC = true;
            continue;
          }
          if (isMinus && ch === 's') {
            readsFromStdin = true;
            continue;
          }
          if (ch === 'o' || (ch === 'O' && interpreter === 'bash')) {
            valueArgsNeeded += 1;
            continue;
          }
          return null;
        }
        if (valueArgsNeeded > 0) {
          if (index + valueArgsNeeded >= tokens.length) return null;
          for (let offset = 1; offset <= valueArgsNeeded; offset += 1) {
            if (!SHELL_OPTION_NAME_PATTERN.test(tokens[index + offset])) return null;
          }
        }
        if (sawC) {
          return { kind: 'no-script-file', ...resultMeta };
        }
        index += 1 + valueArgsNeeded;
        continue;
      }
      break;
    }
    break;
  }

  if (noScriptFile) {
    return { kind: 'no-script-file', ...resultMeta };
  }
  if (readsFromStdin || index >= tokens.length || tokens[index] === '-') {
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
  // Keep `kind: 'binary_executable'` and `truncated` in sync with the local BLOCK check
  // in `host/runtime/host-auto-review.mjs` (`createLocalClassifier`).
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
