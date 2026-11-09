#!/usr/bin/env node
// Maintainer tool: derive the Windows desktop recipes from the macOS recipes.
//
// Both official builds of one version ship the same JavaScript, differing only in build
// IDs, chunk file-name hashes, module order and CRLF line endings inside a few assets.
// Each macOS recipe is replayed on the macOS original, every copied byte range is mapped
// onto the Windows original through a byte alignment, and asset names inside added bytes
// are translated. The output is verified to differ from the macOS result only by
// differences already present between the two originals.
//
//   node windows/tools/port-desktop-recipes.mjs --mac <mac app.asar|dir> --win <win app.asar|dir>
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gunzipSync, gzipSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { applyByteRecipe } from '../../mac/patchers/desktop/release-recipes.mjs';
import { align, gaps, mapRange } from './byte-align.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const macRecipes = path.join(repo, 'mac/patchers/desktop/recipes');
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const output = path.resolve(arg('--out') ?? path.join(repo, 'windows/patchers/desktop'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ASSETS = 'dist/renderer/assets';

async function unpacked(input, temporary, name) {
  if ((await stat(input)).isDirectory()) return input;
  const asar = createRequire(path.join(repo, 'mac/patchers/desktop/package.json'))('@electron/asar');
  const directory = path.join(temporary, name);
  asar.extractAll(input, directory);
  return directory;
}

const maskHashes = text => text
  .replace(/-[A-Za-z0-9_-]{8}(\.(?:js|css|svg|png|wav|mp3|webp|woff2?|json|wasm))/g, '-HASHHASH$1')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID')
  .replace(/\r\n/g, '\n');
const stem = name => name.replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/, '$1');

/** Pair renamed renderer assets by content with hashes, build IDs and CRLF masked. */
async function pairAssets(mac, win) {
  const macNames = await readdir(path.join(mac, ASSETS)), winNames = await readdir(path.join(win, ASSETS));
  const macOnly = macNames.filter(name => !winNames.includes(name));
  const winOnly = new Set(winNames.filter(name => !macNames.includes(name)));
  const masked = new Map();
  const content = async (root, name) => {
    const key = `${root}\0${name}`;
    if (!masked.has(key)) masked.set(key, maskHashes((await readFile(path.join(root, ASSETS, name))).toString('latin1')));
    return masked.get(key);
  };
  const pairs = new Map(), exact = new Set();
  for (const name of macOnly) {
    const candidates = [...winOnly].filter(item => stem(item) === stem(name));
    const source = await content(mac, name);
    let match;
    for (const candidate of candidates) if (await content(win, candidate) === source) { match = candidate; break; }
    if (match) exact.add(name);
    else {
      let best;
      for (const candidate of candidates) {
        const other = await content(win, candidate), delta = Math.abs(other.length - source.length);
        if (!best || delta < best.delta) best = { candidate, delta };
      }
      match = best?.candidate;
    }
    if (match) { pairs.set(name, match); winOnly.delete(match); }
  }
  return { pairs, exact };
}

function translate(text, pairs, exact, strict = true) {
  return text.replace(/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|svg|png|wav|mp3|webp|woff2?|json|wasm)/g, name => {
    if (!pairs.has(name)) return name;
    if (strict && !exact.has(name)) throw new Error(`Referenced asset ${name} has no content-identical Windows counterpart`);
    return pairs.get(name);
  });
}

/**
 * Minified names can differ between the two builds of a bundle. Find where a macOS name
 * is declared, carry that position through the alignment and read the Windows name.
 */
function mapIdentifier(name, macSource, winSource, segments) {
  const mac = macSource.toString('latin1'), win = winSource.toString('latin1');
  const escaped = name.replace(/\$/g, '\\$');
  const declaration = [new RegExp(`function ${escaped}\\(`), new RegExp(`class ${escaped}[ {]`),
    new RegExp(`(?:var|let|const) ${escaped}=`), new RegExp(`[,;]${escaped}=(?!=)`)]
    .map(pattern => pattern.exec(mac)).find(Boolean);
  if (!declaration) throw new Error(`No declaration for exported identifier ${name}`);
  const end = declaration.index + declaration[0].indexOf(name) + name.length;
  const segment = segments.find(item => item.a <= end && end < item.a + item.length);
  if (!segment) throw new Error(`Declaration of ${name} is not aligned`);
  const mapped = segment.b + end - segment.a;
  const result = /([A-Za-z_$][\w$]*)$/.exec(win.slice(Math.max(0, mapped - 64), mapped))?.[1];
  const prefix = declaration[0].slice(0, declaration[0].indexOf(name));
  if (!result || win.slice(mapped - result.length - prefix.length, mapped - result.length) !== prefix)
    throw new Error(`Windows declaration for ${name} does not match`);
  return result;
}

/** Exported bindings in added main-process code follow the Windows names. */
function translateExports(text, macSource, winSource, segments, renamed) {
  if (macSource.equals(winSource)) return text;
  return text.replace(/module\.exports=\{([^}]*)\}/g, (whole, body) => `module.exports={${body.split(',').map(entry => {
    const [key, value] = entry.split(':');
    if (!value) throw new Error(`Unsupported export entry ${entry}`);
    const mapped = mapIdentifier(value, macSource, winSource, segments);
    if (mapped !== value) renamed.push([value, mapped]);
    return `${key}:${mapped}`;
  }).join(',')}}`);
}

// Masking renamed assets, build IDs and line endings.
let normalizedText;
const structure = text => [',', ';', '{', '}', '[', ']', '(', ')'].map(mark => text.split(mark).length - 1).join('/');

const winPath = (relative, pairs) => relative.startsWith(`${ASSETS}/`) && pairs.has(path.basename(relative))
  ? `${ASSETS}/${pairs.get(path.basename(relative))}` : relative;

// Interface text added by the macOS recipes that names the Mac.
const WINDOWS_TEXT = [
  ["grokText('这台 Mac', 'This Mac')", "grokText('这台电脑', 'This PC')"],
  ['the original section cards and Mac permission control', 'the original section cards and local permission control'],
];
const textUses = new Map(WINDOWS_TEXT.map(([from]) => [from, 0]));
function windowsText(text) {
  for (const [from, to] of WINDOWS_TEXT) {
    const parts = text.split(from);
    textUses.set(from, textUses.get(from) + parts.length - 1);
    text = parts.join(to);
  }
  return text;
}

const temporary = await mkdtemp(path.join(os.tmpdir(), 'grokbot-port-'));
try {
  const mac = await unpacked(path.resolve(arg('--mac')), temporary, 'mac');
  const win = await unpacked(path.resolve(arg('--win')), temporary, 'win');
  const { pairs, exact } = await pairAssets(mac, win);
  normalizedText = (bytes, rename) => maskHashes(rename ? translate(bytes.toString('latin1'), pairs, exact, false) : bytes.toString('latin1'));
  const manifest = JSON.parse(await readFile(path.join(macRecipes, 'manifest.json'), 'utf8'));
  const recipes = path.join(output, 'recipes');
  await mkdir(recipes, { recursive: true });
  const files = [], report = [];
  for (const [index, entry] of manifest.files.entries()) {
    const recipe = JSON.parse(gunzipSync(await readFile(path.join(macRecipes, entry.recipe))));
    const macSource = entry.source === null ? Buffer.alloc(0) : await readFile(path.join(mac, entry.source));
    applyByteRecipe(macSource, recipe); // The macOS recipe must match its own original.
    const sourcePath = entry.source === null ? null : winPath(entry.source, pairs);
    const winSource = sourcePath === null ? Buffer.alloc(0) : await readFile(path.join(win, sourcePath));
    const segments = align(macSource, winSource), differences = gaps(macSource, winSource, segments);
    const sizes = { a: macSource.length, b: winSource.length };
    // `expected` is the macOS result with the Windows additions: copies from the macOS
    // original, so every remaining difference must come from the originals.
    const ops = [], renamed = [], expected = [];
    for (const op of recipe.ops) {
      if (op[0] === 'copy') {
        for (const [offset, length] of mapRange(op[1], op[2], segments, sizes)) {
          const last = ops.at(-1);
          if (last?.[0] === 'copy' && last[1] + last[2] === offset) last[2] += length;
          else ops.push(['copy', offset, length]);
          // Platform builds differ in names, IDs, order and line endings, never in syntax.
          const left = structure(normalizedText(macSource.subarray(op[1], op[1] + op[2]), true));
          const right = structure(normalizedText(winSource.subarray(offset, offset + length), false));
          if (left !== right) throw new Error(`Copied range ${op[1]}+${op[2]} of ${entry.path} changes structure on Windows: ${left} -> ${right}`);
        }
        expected.push(macSource.subarray(op[1], op[1] + op[2]));
      } else {
        let text = translate(Buffer.from(op[1], 'base64').toString('utf8'), pairs, exact);
        if (!entry.path.startsWith('dist/renderer/')) text = translateExports(text, macSource, winSource, segments, renamed);
        else text = windowsText(text);
        ops.push(['add', Buffer.from(text, 'utf8').toString('base64')]);
        expected.push(Buffer.from(text, 'utf8'));
      }
    }
    const target = Buffer.concat(ops.map(op => op[0] === 'copy' ? winSource.subarray(op[1], op[1] + op[2]) : Buffer.from(op[1], 'base64')));
    const ported = { schema: 'grokbot-bytepatch/v1', sourceBytes: winSource.length, sourceSha256: sha(winSource),
      targetBytes: target.length, targetSha256: sha(target), ops };
    if (!applyByteRecipe(winSource, ported).equals(target)) throw new Error(`Recipe replay mismatch for ${entry.path}`);
    const normalized = (bytes, rename) => Buffer.from(normalizedText(bytes, rename), 'latin1');
    const [sourceLeft, sourceRight] = [normalized(macSource, true), normalized(winSource, false)];
    const [targetLeft, targetRight] = [normalized(Buffer.concat(expected), true), normalized(target, false)];
    const known = new Set(gaps(sourceLeft, sourceRight, align(sourceLeft, sourceRight))
      .map(gap => sourceLeft.toString('latin1', gap.a, gap.aEnd) + '\0' + sourceRight.toString('latin1', gap.b, gap.bEnd)));
    const outputDifferences = gaps(targetLeft, targetRight, align(targetLeft, targetRight));
    const unexplained = outputDifferences.filter(gap =>
      !known.has(targetLeft.toString('latin1', gap.a, gap.aEnd) + '\0' + targetRight.toString('latin1', gap.b, gap.bEnd)));
    if (unexplained.length) {
      for (const gap of unexplained.slice(0, 5)) console.error(entry.path, JSON.stringify(targetLeft.toString('utf8', Math.max(0, gap.a - 40), gap.aEnd + 40)),
        '->', JSON.stringify(targetRight.toString('utf8', Math.max(0, gap.b - 40), gap.bEnd + 40)));
      throw new Error(`Unexplained differences in ${entry.path}`);
    }
    const name = `${String(index).padStart(3, '0')}.gbp.gz`;
    const compressed = gzipSync(JSON.stringify(ported), { level: constants.Z_BEST_COMPRESSION });
    await writeFile(path.join(recipes, name), compressed);
    const added = ops.filter(op => op[0] === 'add').reduce((sum, op) => sum + Buffer.from(op[1], 'base64').length, 0);
    files.push({ path: winPath(entry.path, pairs), source: sourcePath, newFile: entry.newFile, recipe: name,
      sha256: sha(compressed), targetBytes: target.length, addedBytes: added });
    report.push({ path: winPath(entry.path, pairs), platformDifferences: differences.length, outputDifferences: outputDifferences.length,
      ...(renamed.length ? { renamedExports: Object.fromEntries(renamed) } : {}) });
  }
  for (const [from, uses] of textUses) if (!uses) throw new Error(`Expected interface text not found: ${from}`);
  await writeFile(path.join(recipes, 'manifest.json'), JSON.stringify({ schema: manifest.schema, files }, null, 2) + '\n');
  // The notification decider is read from the user's original; only its location is recorded.
  const policy = JSON.parse(await readFile(path.join(repo, 'mac/patchers/desktop/notification-policy.json'), 'utf8'));
  const macPolicySource = await readFile(path.join(mac, policy.source)), winPolicySource = await readFile(path.join(win, policy.source));
  const [[offset, length], ...rest] = mapRange(policy.byteOffset, policy.byteLength, align(macPolicySource, winPolicySource),
    { a: macPolicySource.length, b: winPolicySource.length });
  if (rest.length || length !== policy.byteLength || sha(winPolicySource.subarray(offset, offset + length)) !== policy.sha256)
    throw new Error('Notification decider differs on Windows');
  await writeFile(path.join(output, 'notification-policy.json'), JSON.stringify({ ...policy,
    sourceSha256: sha(winPolicySource), byteOffset: offset }, null, 2) + '\n');
  console.log(JSON.stringify({ recipes: files.length, report }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
