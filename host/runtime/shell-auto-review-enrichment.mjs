import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const SHELL_ENRICHMENT_PREVIEW_MAX_CHARS = 8_000;
export const SHELL_ENRICHMENT_PREVIEW_MAX_LINES = 200;
export const SHELL_ENRICHMENT_FULL_HASH_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_AUTO_REVIEW_CLASSIFIER_MAX_ATTEMPTS = 2;

const INTERPRETER_PATTERN = /^(python(?:3(?:\.\d+)?)?|node|bash|sh|zsh)(?=[ \t\n]|$)/;
// Only ASCII space, tab, and newline are treated as shell whitespace; any other control
// character (including \r, \v, \f, NUL) or Unicode whitespace (such as NBSP \u00a0) fails closed.
const DISALLOWED_WHITESPACE_OR_CONTROL_PATTERN =
  /[\x00-\x08\x0b-\x1f\x7f\u0080-\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

const DANGEROUS_ENV_EXACT = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'OPENSSL_CONF',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'HOME',
  'XDG_CONFIG_HOME',
  'PS4',
  'SHELLOPTS',
  'BASHOPTS',
]);
const ENV_ASSIGNMENT_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^ \t\n;&|<>]+)[ \t]+/;

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
const PYTHON_BOOL_SHORT_FLAGS = new Set(['b', 'B', 'd', 'E', 'I', 'O', 'P', 'q', 's', 'S', 'u', 'v']);
const PYTHON_VALUE_SHORT_FLAGS = new Set(['W', 'X']);
const PYTHON_LONG_INLINE_FLAGS = new Set(['--version', '--help']);
const PYTHON_LONG_VALUE_FLAGS = new Set(['--check-hash-based-pycs']);

const NODE_INLINE_INFO_FLAGS = new Set(['-v', '--version', '-h', '--help']);
// `-p` / `--print` are left out on purpose: Node treats them as a switch when the next word starts
// with `-` (or expands to nothing) and still runs the script after it, so they keep the stock result.
// `-e`, `-pe` and `--eval` always consume the next word as code (or fail without running anything).
const NODE_INLINE_CODE_FLAGS = new Set(['-e', '-pe', '--eval']);
const NODE_INLINE_CODE_EQUALS_FLAGS = new Set(['--eval']);
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

const SHELL_BOOL_SHORT_FLAGS = new Set(['a', 'C', 'e', 'f', 'h', 'm', 'n', 'p', 'u', 'v', 'x']);
const SHELL_LONG_INLINE_FLAGS = new Set(['--version', '--help']);
const SHELL_LONG_BOOL_FLAGS = new Set(['--noprofile', '--norc', '--posix', '--verbose']);
const SHELL_O_OPTIONS = new Set([
  'errexit',
  'nounset',
  'pipefail',
  'xtrace',
  'verbose',
  'noglob',
  'noclobber',
  'allexport',
  'noexec',
]);
const BASH_SHOPT_OPTIONS = new Set([
  'extglob',
  'globstar',
  'nullglob',
  'failglob',
  'dotglob',
  'nocaseglob',
  'lastpipe',
]);
const SHELL_EXPANSION_CHAR_PATTERN = /[~$`*?[{\\]/;

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

function trimAsciiShellSpace(value) {
  return String(value ?? '').replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

/** Strip up to four env / `cd <dir> &&` prefixes matching stock sand-shell-auto-review-enrichment. */
export function stripShellPrefixes(command, workingDirectory) {
  let candidateCommand = trimAsciiShellSpace(command);
  let candidateWorkingDirectory = workingDirectory;
  const envNames = [];
  let hasUnsafeCdTarget = false;
  for (let prefixCount = 0; prefixCount < 4; prefixCount += 1) {
    let rest = candidateCommand;
    const leadingEnv = rest.match(/^env[ \t]+/);
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
      /^cd[ \t]+("[^"]+"|'[^']+'|[^ \t\n;&|]+)[ \t]*&&[ \t]*(.+)$/s,
    );
    if (changeDirectoryPrefix === null) break;
    const rawTarget = changeDirectoryPrefix[1];
    const target = unquote(rawTarget);
    if (SHELL_EXPANSION_CHAR_PATTERN.test(rawTarget) || SHELL_EXPANSION_CHAR_PATTERN.test(target)) {
      hasUnsafeCdTarget = true;
    }
    if (candidateWorkingDirectory !== undefined) {
      candidateWorkingDirectory = path.posix.resolve(candidateWorkingDirectory, target);
    } else if (path.posix.isAbsolute(target)) {
      candidateWorkingDirectory = path.posix.resolve(target);
    }
    candidateCommand = trimAsciiShellSpace(changeDirectoryPrefix[2]);
  }
  return { command: candidateCommand, workingDirectory: candidateWorkingDirectory, envNames, hasUnsafeCdTarget };
}

/**
 * Validate that the tail after `<<` is a pure heredoc header (`[-]DELIMITER`) with no other
 * words, operators, or redirections remaining on the same command line.
 */
function isPureHeredocTail(tail) {
  const newlineIndex = tail.indexOf('\n');
  const firstLine = newlineIndex === -1 ? tail : tail.slice(0, newlineIndex);
  if (DISALLOWED_WHITESPACE_OR_CONTROL_PATTERN.test(firstLine)) return false;

  let index = 0;
  if (firstLine[index] === '-') index += 1;
  while (index < firstLine.length && (firstLine[index] === ' ' || firstLine[index] === '\t')) {
    index += 1;
  }

  let quote = null;
  let escaping = false;
  let sawDelimiter = false;
  for (; index < firstLine.length; index += 1) {
    const ch = firstLine[index];
    if (escaping) {
      sawDelimiter = true;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else sawDelimiter = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && index + 1 < firstLine.length) escaping = true;
      else sawDelimiter = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      break;
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '(' || ch === ')' || ch === '`' || ch === '$') {
      return false;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    sawDelimiter = true;
  }

  if (!sawDelimiter || quote !== null || escaping) return false;
  while (index < firstLine.length) {
    if (firstLine[index] !== ' ' && firstLine[index] !== '\t') return false;
    index += 1;
  }
  return true;
}

/**
 * Tokenize the first simple command segment using ASCII space/tab/newline separators only.
 * Any unquoted `<` or `>` (including `&>` and fd-prefixed redirections like `2>&1` / `0<file`)
 * sets `hasRedirection = true`, with the sole exception of a trailing pure heredoc (`<<EOF`
 * with no words after the delimiter on the same line).
 */
function tokenizeFirstSegment(command) {
  const tokens = [];
  const rawTokens = [];
  let current = '';
  let rawCurrent = '';
  let quote = null;
  let escaping = false;
  let hasToken = false;
  let hasRedirection = false;
  let hasPureHeredoc = false;
  let hasComment = false;
  let hasInvalidSyntax = false;

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
    if (DISALLOWED_WHITESPACE_OR_CONTROL_PATTERN.test(ch)) {
      hasInvalidSyntax = true;
      break;
    }
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
      if (!hasToken && command[index + 1] === '<' && command[index + 2] !== '<' && isPureHeredocTail(command.slice(index + 2))) {
        hasPureHeredoc = true;
      } else {
        hasRedirection = true;
      }
      break;
    }
    if (ch === '>') {
      hasRedirection = true;
      break;
    }
    if (ch === '&') {
      if (command[index + 1] === '>') {
        hasRedirection = true;
      }
      break;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      break;
    }
    if (ch === '#' && !hasToken) {
      hasComment = true;
      break;
    }
    if (ch === ' ' || ch === '\t') {
      flushToken();
      continue;
    }
    current += ch;
    rawCurrent += ch;
    hasToken = true;
  }
  if (quote !== null || escaping) {
    hasInvalidSyntax = true;
  }
  flushToken();
  return { tokens, rawTokens, hasRedirection, hasPureHeredoc, hasComment, hasInvalidSyntax };
}

function hasFlagWithEquals(token, flagSet) {
  const eq = token.indexOf('=');
  return eq > 0 && flagSet.has(token.slice(0, eq));
}

/**
 * Inspect interpreter invocations (python/node/bash/sh/zsh) using strict per-interpreter
 * allowlists so safe inline/version flags (`-v`, `-V`, `-c`, `-e`, `-pe`, inline `python3 -` /
 * `node -` / `sh -s` without `< file`) are not misparsed as script paths on disk, while real
 * script arguments after allowlisted flags (e.g. `python3 -uW ignore foo.py`,
 * `bash -O extglob foo.sh`, `node --unhandled-rejections strict foo.js`) resolve to the actual
 * script path.
 * Any unrecognized/disallowed flag (e.g. `-r`, `--require`, `--import`, `--env-file`,
 * `--rcfile`, `--test`, `--run`, `--experimental-config-file`, `--openssl-config`,
 * `-l`/`--login`, `python3 -m`, `python3 -x`, unsafe `-o`/`-O` option names), file stdin
 * redirection (`< file`), shell expansion chars in the script token, or startup/loader env
 * prefix (`NODE_OPTIONS`, `BASH_ENV`, `ENV`, `HOME`, `ZDOTDIR`, `XDG_CONFIG_HOME`, `PS4`,
 * `LD_*`, `DYLD_*`, `PYTHON*`, etc.) returns `null` so the stock enrichment decision is
 * preserved unchanged.
 */
export function parseInterpreterInvocation(command, workingDirectory) {
  const stripped = stripShellPrefixes(command, workingDirectory);
  if (!stripped.command || stripped.hasUnsafeCdTarget) return null;
  if (stripped.envNames.some(isDangerousEnvVar)) return null;
  const match = stripped.command.match(INTERPRETER_PATTERN);
  if (!match) return null;

  const interpreter = match[1];
  const { tokens, rawTokens, hasRedirection, hasPureHeredoc, hasComment, hasInvalidSyntax } = tokenizeFirstSegment(stripped.command);
  if (hasInvalidSyntax || hasRedirection || hasComment || tokens.length < 2) return null;

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
  let needsInlineCommandArg = false;
  let readsFromStdin = false;
  while (index < tokens.length) {
    const token = tokens[index];
    const rawToken = rawTokens[index];
    if (isShell && needsInlineCommandArg && !token.startsWith('-') && !token.startsWith('+')) {
      // Inline command code after `-c` (e.g. `bash -c "echo 2*3"`).
      break;
    }
    const isPythonInlineAttachedCode = isPython && /^-[bBdEIOPqSsSuv]*c/.test(rawToken);
    const eqRawIdx = rawToken.indexOf('=');
    const isNodeInlineEqualsCode =
      isNode && eqRawIdx > 0 && NODE_INLINE_CODE_EQUALS_FLAGS.has(rawToken.slice(0, eqRawIdx));
    if (!isPythonInlineAttachedCode && !isNodeInlineEqualsCode && SHELL_EXPANSION_CHAR_PATTERN.test(rawToken)) {
      return null;
    }
    if (token === '--' || (isShell && token === '-')) {
      index += 1;
      break;
    }
    if (isShell && token === '+') {
      // dash and zsh treat standalone `+` as end-of-options while bash treats it as an empty
      // option group. Fail closed when the next token begins with `-` or `+` where shells diverge.
      const next = tokens[index + 1];
      if (next !== undefined && (next.startsWith('-') || next.startsWith('+'))) {
        return null;
      }
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
          noScriptFile = true;
          break;
        }
        if (PYTHON_LONG_VALUE_FLAGS.has(token)) {
          if (index + 1 >= tokens.length || SHELL_EXPANSION_CHAR_PATTERN.test(rawTokens[index + 1])) return null;
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
            if (charIdx + 1 === token.length && index + 1 >= tokens.length) return null;
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
            let flagValue;
            if (charIdx + 1 < token.length) {
              flagValue = token.slice(charIdx + 1);
              index += 1;
            } else {
              if (index + 1 >= tokens.length || SHELL_EXPANSION_CHAR_PATTERN.test(rawTokens[index + 1])) return null;
              flagValue = tokens[index + 1];
              index += 2;
            }
            if (ch === 'W' && flagValue.includes('.')) return null;
            consumedValue = true;
            break;
          }
          return null;
        }
        if (sawInlineCode || sawVersionOrHelp) {
          noScriptFile = true;
          break;
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
        if (index + 1 >= tokens.length || SHELL_EXPANSION_CHAR_PATTERN.test(rawTokens[index + 1])) return null;
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
          needsInlineCommandArg = false;
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
        const neededOptionSets = [];
        for (let charIdx = 1; charIdx < token.length; charIdx += 1) {
          const ch = token[charIdx];
          if (SHELL_BOOL_SHORT_FLAGS.has(ch)) {
            continue;
          }
          if (isMinus && ch === 'c') {
            noScriptFile = true;
            needsInlineCommandArg = true;
            continue;
          }
          if (isMinus && ch === 's') {
            readsFromStdin = true;
            continue;
          }
          if (ch === 'o' && interpreter !== 'zsh') {
            neededOptionSets.push(SHELL_O_OPTIONS);
            continue;
          }
          if (ch === 'O' && interpreter === 'bash') {
            neededOptionSets.push(BASH_SHOPT_OPTIONS);
            continue;
          }
          return null;
        }
        if (neededOptionSets.length > 0) {
          if (index + neededOptionSets.length >= tokens.length) return null;
          for (let offset = 0; offset < neededOptionSets.length; offset += 1) {
            if (
              SHELL_EXPANSION_CHAR_PATTERN.test(rawTokens[index + 1 + offset]) ||
              !neededOptionSets[offset].has(tokens[index + 1 + offset])
            ) {
              return null;
            }
          }
        }
        index += 1 + neededOptionSets.length;
        continue;
      }
      break;
    }
    break;
  }

  if (noScriptFile) {
    if (hasPureHeredoc) return null;
    if (needsInlineCommandArg && index >= tokens.length) return null;
    return { kind: 'no-script-file', ...resultMeta };
  }
  if (readsFromStdin || index >= tokens.length || (!isShell && tokens[index] === '-')) {
    return { kind: 'no-script-file', ...resultMeta };
  }
  if (hasPureHeredoc) {
    // Pure heredoc exception applies only when the interpreter reads its program from stdin.
    return null;
  }
  const scriptToken = tokens[index];
  const rawScriptToken = rawTokens[index];
  if (
    SHELL_EXPANSION_CHAR_PATTERN.test(rawScriptToken) ||
    SHELL_EXPANSION_CHAR_PATTERN.test(scriptToken)
  ) {
    return null;
  }
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

function extractInterpreterLeadingFlag(command, workingDirectory) {
  const stripped = stripShellPrefixes(command, workingDirectory);
  if (!stripped.command || stripped.workingDirectory === undefined) return null;
  const match = stripped.command.match(INTERPRETER_PATTERN);
  if (!match) return null;
  const interpreter = match[1];
  const isShell = interpreter === 'bash' || interpreter === 'sh' || interpreter === 'zsh';
  const rest = stripped.command.slice(match[0].length).replace(/^[ \t]+/, '');
  if (!rest) return null;
  const tokenMatch = /^("[^"]*"|'[^']*'|[^ \t\n;&|]+)/.exec(rest);
  if (!tokenMatch) return null;
  const rawFirstArg = tokenMatch[1];
  const firstArg = unquote(rawFirstArg);
  const startsWithFlagPrefix =
    firstArg.startsWith('-') ||
    rawFirstArg.startsWith('-') ||
    (isShell && (firstArg.startsWith('+') || rawFirstArg.startsWith('+')));
  if (!startsWithFlagPrefix) return null;
  return {
    firstArg,
    rawFirstArg,
    workingDirectory: stripped.workingDirectory,
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
 * 1. Stock enrichment runs first; when stock returns `kind: "executable"` and `path`
 *    matches `working_directory + <firstFlag>` (whether stock failed to bind or bound a
 *    decoy file named after the flag such as `-` or `-u`), we clear allowlisted
 *    inline/version flags (`node -v`, `python3 -c`, `bash -c`) or re-bind scripts after
 *    allowlisted flags (`python3 -u script.py`, `bash - evil.sh`);
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
    } else if (!interpreterTarget && stock?.kind === 'executable') {
      const leadingFlag = extractInterpreterLeadingFlag(args?.command, args?.workingDirectory);
      if (
        leadingFlag &&
        isInterpreterFirstFlagPath(
          stock.path,
          leadingFlag.workingDirectory,
          leadingFlag.firstArg,
          leadingFlag.rawFirstArg,
        )
      ) {
        // Never allow stock enrichment (or our probe fallback) to bind a harmless file in cwd
        // named after an interpreter option such as `-r`, `-e`, `-u`, `-c`, or `+`.
        return stock.approval_binding_unavailable === true
          ? stock
          : {
              kind: 'executable',
              path: stock.path,
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
