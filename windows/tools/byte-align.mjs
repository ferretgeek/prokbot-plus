// Byte alignment between two builds of the same bundle, used to port recipes.

/** Equal runs between two mostly identical buffers: [{ a, b, length }], monotonic in both. */
export function align(a, b, { k = 32, window = 1 << 16 } = {}) {
  const segments = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    let n = 0;
    while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
    if (n) { segments.push({ a: i, b: j, length: n }); i += n; j += n; continue; }
    const grams = new Map();
    for (let q = j, end = Math.min(b.length - k, j + window); q <= end; q++) {
      const key = b.toString('latin1', q, q + k);
      if (!grams.has(key)) grams.set(key, q);
    }
    let best;
    for (let p = i, end = Math.min(a.length - k, i + window); p <= end; p++) {
      if (best && p - i >= best.cost) break;
      const q = grams.get(a.toString('latin1', p, p + k));
      if (q !== undefined && (!best || p - i + q - j < best.cost)) best = { p, q, cost: p - i + q - j };
    }
    if (!best) break;
    i = best.p; j = best.q;
  }
  return segments;
}

/** Differing regions between consecutive equal runs, including the head and tail. */
export function gaps(a, b, segments) {
  const bounded = [{ a: 0, b: 0, length: 0 }, ...segments, { a: a.length, b: b.length, length: 0 }];
  const result = [];
  for (let index = 1; index < bounded.length; index++) {
    const previous = bounded[index - 1], next = bounded[index];
    const start = { a: previous.a + previous.length, b: previous.b + previous.length };
    if (start.a < next.a || start.b < next.b) result.push({ a: start.a, aEnd: next.a, b: start.b, bEnd: next.b });
  }
  return result;
}

// Every resynchronisation in align() requires this many equal bytes, so an equal run
// shorter than this can only be the leading run of the files.
const ANCHOR = 32;

/**
 * Map a byte position at the start (side 'start') or end (side 'end') of a copied
 * macOS range. Positions inside a differing region have no unambiguous counterpart.
 */
function mapPosition(position, side, segments, sizes) {
  if (position === 0 && side === 'start') return 0;
  if (position === sizes.a && side === 'end') return sizes.b;
  const segment = segments.find(item => side === 'start'
    ? item.a <= position && position < item.a + item.length
    : item.a < position && position <= item.a + item.length);
  if (!segment) throw new Error(`Copy boundary ${position} falls inside a platform difference`);
  if (segment.length < ANCHOR && (segment.a !== 0 || segment.b !== 0)) throw new Error(`Copy boundary ${position} lies in a short equal run`);
  return segment.b + position - segment.a;
}

/**
 * Map one copied macOS byte range onto Windows. Alignment is monotonic, so the
 * counterpart is one contiguous Windows range: everything the Windows build inserts,
 * removes or reorders between the two anchored boundaries is taken from Windows.
 */
export function mapRange(offset, length, segments, sizes) {
  const start = mapPosition(offset, 'start', segments, sizes), end = mapPosition(offset + length, 'end', segments, sizes);
  if (end <= start) throw new Error(`Copy range ${offset}+${length} has no Windows counterpart`);
  return [[start, end - start]];
}
