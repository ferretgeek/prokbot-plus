import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const SHELL_ENRICHMENT_PREVIEW_MAX_CHARS = 8_000;
export const SHELL_ENRICHMENT_PREVIEW_MAX_LINES = 200;
export const SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES = 16 * 1024 * 1024;
export const SHELL_ENRICHMENT_BOUNDED_CHUNK_BYTES = 65_536;
export const DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = 2;

const INTERPRETER_PATTERN = /^(python(?:3(?:\.\d+)?)?|node|bash|sh|zsh)(?=\s|$)/;

const PYTHON_INLINE_FLAGS = new Set(['-c', '-m', '-V', '--version', '-h', '--help', '-']);
const PYTHON_VALUE_FLAGS = new Set(['-W', '-X', '--check-hash-based-pycs']);

const NODE_INLINE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-v', '--version', '-h', '--help', '-']);
const NODE_VALUE_FLAGS = new Set([
  '-r', '--require', '--import', '--loader', '--experimental-loader',
  '-C', '--conditions', '--env-file', '--env-file-if-exists',
  '--max-old-space-size', '--test-name-pattern', '--input-type',
  '--diagnostic-dir', '--redirect-warnings', '--title',
]);

const SHELL_INLINE_FLAGS = new Set(['-c', '-s', '--version', '--help', '-']);
const SHELL_VALUE_FLAGS = new Set(['-o', '+o', '--rcfile', '--init-file']);

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

/** Tokenize the first simple command segment (stopping at unquoted separators/redirections). */
function tokenizeFirstSegment(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaping = false;
  let hasToken = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (escaping) {
      current += ch;
      hasToken = true;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && index + 1 < command.length) {
        escaping = true;
      } else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n' || ch === '<' || ch === '>') {
      break;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Inspect interpreter invocations (python/node/bash/sh/zsh) so option flags such as
 * `-v`, `-V`, `-c`, `-e`, `-m`, `-lc`, or `-` (stdin) are never misparsed as script
 * paths on disk, while real script arguments after flags (e.g. `python3 -u foo.py`)
 * still resolve to the target script path.
 */
export function parseInterpreterInvocation(command, workingDirectory) {
  const stripped = stripShellPrefixes(command, workingDirectory);
  if (!stripped.command) return null;
  const match = stripped.command.match(INTERPRETER_PATTERN);
  if (!match) return null;

  const interpreter = match[1];
  const tokens = tokenizeFirstSegment(stripped.command);
  if (tokens.length < 2) return { kind: 'no-script-file', interpreter };

  const firstArg = tokens[1];
  const firstArgIsFlag = firstArg === '-' || firstArg.startsWith('-') ||
    ((interpreter === 'bash' || interpreter === 'sh' || interpreter === 'zsh') && firstArg.startsWith('+'));
  if (!firstArgIsFlag) {
    // Stock enrichment already parses direct script paths like `python3 foo.py`.
    return null;
  }

  const isPython = interpreter.startsWith('python');
  const isNode = interpreter === 'node';
  const isShell = interpreter === 'bash' || interpreter === 'sh' || interpreter === 'zsh';

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '-') {
      return { kind: 'no-script-file', interpreter };
    }
    if (isPython) {
      if (PYTHON_INLINE_FLAGS.has(token) || token.startsWith('-c') || token.startsWith('-m')) {
        return { kind: 'no-script-file', interpreter };
      }
      if (token.startsWith('-W') || token.startsWith('-X')) {
        index += token.length === 2 ? 2 : 1;
        continue;
      }
      if (PYTHON_VALUE_FLAGS.has(token)) {
        index += 2;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(token) && /[cmVh]/.test(token.slice(1))) {
        return { kind: 'no-script-file', interpreter };
      }
      if (token.startsWith('-')) {
        index += 1;
        continue;
      }
      break;
    }
    if (isNode) {
      if (NODE_INLINE_FLAGS.has(token) || token.startsWith('--eval=') || token.startsWith('--print=')) {
        return { kind: 'no-script-file', interpreter };
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
      if (SHELL_INLINE_FLAGS.has(token)) return { kind: 'no-script-file', interpreter };
      if (/^-[A-Za-z]+$/.test(token) && /[cs]/.test(token.slice(1))) {
        return { kind: 'no-script-file', interpreter };
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

  if (index >= tokens.length || tokens[index] === '-') {
    return { kind: 'no-script-file', interpreter };
  }
  const scriptToken = tokens[index];
  if (path.posix.isAbsolute(scriptToken)) {
    return { kind: 'script-after-flags', interpreter, path: scriptToken };
  }
  if (stripped.workingDirectory === undefined) {
    return { kind: 'no-script-file', interpreter };
  }
  return {
    kind: 'script-after-flags',
    interpreter,
    path: path.posix.resolve(stripped.workingDirectory, scriptToken),
  };
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
  {
    fullHashMaxBytes = SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES,
    boundedChunkBytes = SHELL_ENRICHMENT_BOUNDED_CHUNK_BYTES,
  } = {},
) {
  if (typeof targetPath !== 'string' || targetPath.length === 0 || targetPath.includes('\0')) {
    throw new Error('Invalid executable path for auto-review binding');
  }
  const quoted = shellSingleQuote(targetPath);
  return (
    `p=${quoted}; ` +
    `[ -f "$p" ] && [ -r "$p" ] || exit 2; ` +
    `st="$(stat -L -c '%d:%i:%s:%Y:%Z:%a' "$p" 2>/dev/null || stat -L -f '%d:%i:%z:%m:%c:%Lp' "$p" 2>/dev/null)" || exit 3; ` +
    `sz="$(printf '%s' "$st" | cut -d: -f3)"; ` +
    `case "$sz" in ''|*[!0-9]*) exit 3 ;; esac; ` +
    `hasher() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; ` +
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'; ` +
    `else openssl dgst -sha256 -r | awk '{print $1}'; fi; }; ` +
    `if [ "$sz" -le ${fullHashMaxBytes} ]; then ` +
    `scope="full-sha256"; h="$(hasher < "$p")" || exit 4; ` +
    `else scope="stat-head-tail-64k"; ` +
    `h="$({ printf '%s\\n' "$st"; head -c ${boundedChunkBytes} "$p"; tail -c ${boundedChunkBytes} "$p"; } | hasher)" || exit 4; fi; ` +
    `b64="$(head -c ${SHELL_ENRICHMENT_PREVIEW_MAX_CHARS} "$p" | base64 | tr -d '\\r\\n')"; ` +
    `printf 'stat=%s\\nsize=%s\\nscope=%s\\nsha256=%s\\nhead_b64=%s\\n' "$st" "$sz" "$scope" "$h" "$b64"`
  );
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
  if (scope !== 'full-sha256' && scope !== 'stat-head-tail-64k') return undefined;

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
    ...(scope !== 'full-sha256' ? { hash_scope: scope } : {}),
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
      boundedChunkBytes: deps.boundedChunkBytes ?? SHELL_ENRICHMENT_BOUNDED_CHUNK_BYTES,
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

export function readAutoReviewClassifierMaxAttempts(env = process.env, fallback = DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS) {
  const raw = env?.GROKBOT_AUTO_REVIEW_MAX_ATTEMPTS;
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) return fallback;
  return parsed;
}

/**
 * Wrap the stock Shell auto-review target enrichment so:
 * 1. Interpreter flags (`node -v`, `python3 -c`, `bash -lc`, `python3 -`, etc.) are not
 *    misparsed as script file paths when `working_directory` is set;
 * 2. Scripts invoked after flags (`python3 -u script.py`) still resolve and bind the script;
 * 3. Large text scripts (>200 lines / >8 KiB) and compiled binaries (ELF/Mach-O/PE) bind
 *    deterministically by file hash instead of tripping a hard `approval_binding_unavailable` veto;
 * 4. Missing, unreadable, or non-regular paths still fail closed with the stock unavailable marker.
 */
export function wrapSandShellAutoReviewTargetEnrichment(originalEnrich, deps = {}) {
  if (typeof originalEnrich !== 'function') return originalEnrich;
  return async function enhancedSandShellAutoReviewTargetEnrichment(ctx, args) {
    const interpreterTarget = parseInterpreterInvocation(args?.command, args?.workingDirectory);
    if (interpreterTarget?.kind === 'no-script-file') {
      return undefined;
    }

    if (interpreterTarget?.kind === 'script-after-flags') {
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

    const stock = await originalEnrich(ctx, args);
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
