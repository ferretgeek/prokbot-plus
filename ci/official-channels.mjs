// Public release metadata only. Nothing here follows an artifact URL or writes a pin.
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const iosId = 6794501026;
const iosBundle = 'co.anysphere.sand';
const iosListing = `https://apps.apple.com/us/app/grok-bot/id${iosId}`;
const desktopDocs = 'https://docs.x.ai/grok-bot/deployment';
const feeds = {
  windows: 'https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand',
  mac: 'https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand',
  ios: `https://itunes.apple.com/lookup?id=${iosId}&country=us`,
};
const maxBytes = 128 * 1024;
const timeoutMs = 10_000;
const pins = {
  windows: 'windows/patchers/desktop/supported.json', mac: 'mac/patchers/desktop/supported.json',
  ios: 'ios/recipes/ios/manifest.json', android: 'android/patchers/supported.json',
  cloud: 'host/recipes/host/manifest.json',
};

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function version(value) {
  check(typeof value === 'string' && /^(0|[1-9]\d{0,8})(\.(0|[1-9]\d{0,8})){1,2}$/.test(value),
    'Expected a numeric stable release version');
  return value;
}

function compareVersion(observed, pinned) {
  const a = observed.split('.').map(Number), b = pinned.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff > 0 ? 'newer' : 'older';
  }
  return 'same';
}

function sha256(value) {
  check(typeof value === 'string' && /^[\da-f]{64}$/i.test(value), 'Invalid SHA-256');
  return value.toLowerCase();
}

function artifactUrl(channel, release, url) {
  const suffix = channel === 'windows' ? `win32-x64/${release}/Grok_Bot_${release}_Setup.exe`
    : `darwin-arm64/${release}/Grok_Bot_${release}.dmg`;
  check(url === `https://downloads.cursor.com/grokbot/stable/${suffix}`,
    'Unexpected Grok Bot artifact URL for this platform and version');
  return url;
}

function desktopObservation(channel, data) {
  const release = version(data?.version);
  const downloadUrl = artifactUrl(channel, release, data.downloadUrl);
  check(typeof data.commitSha === 'string' && /^[0-9a-f]{40}$/i.test(data.commitSha),
    'Expected commitSha (a build ID, not the installer SHA-256)');
  return { version: release, downloadUrl, buildId: data.commitSha, buildIdField: 'commitSha',
    publishedArchiveSha256: Object.hasOwn(data, 'sha256') ? sha256(data.sha256) : null };
}

function iosObservation(data) {
  check(data?.resultCount === 1 && Array.isArray(data.results) && data.results.length === 1,
    'Expected exactly one US Apple software lookup result');
  const app = data.results[0];
  check(app?.wrapperType === 'software' && app.kind === 'software' && app.trackId === iosId &&
    app.bundleId === iosBundle && app.trackName === 'Grok Bot', 'Wrong Apple product, track ID or bundle ID');
  const listing = typeof app.trackViewUrl === 'string' && URL.parse(app.trackViewUrl);
  check(listing && !listing.username && !listing.password && !listing.hash &&
    `${listing.origin}${listing.pathname}` === iosListing,
    'Wrong US App Store listing');
  const releasedAt = app.currentVersionReleaseDate;
  const time = typeof releasedAt === 'string' ? Date.parse(releasedAt) : NaN;
  const iso = Number.isFinite(time) ? new Date(time).toISOString() : '';
  check(iso && (releasedAt === iso || releasedAt === iso.replace('.000Z', 'Z')), 'Invalid App Store release date');
  return { version: version(app.version), trackId: iosId, bundleId: iosBundle, trackName: app.trackName,
    releasedAt, listingUrl: iosListing, build: null, publishedArchiveSha256: null };
}

async function readPin(channel) {
  let data;
  try {
    data = JSON.parse(await readFile(new URL(`../${pins[channel]}`, import.meta.url), 'utf8'));
  } catch {
    throw new Error(`Cannot read local pin: ${pins[channel]}`);
  }
  if (channel === 'windows' || channel === 'mac') {
    check(data.architecture === (channel === 'windows' ? 'x64' : 'arm64'), 'Unexpected pinned architecture');
    const release = version(data.version);
    return { version: release, archiveUrl: artifactUrl(channel, release, data.archive?.url),
      archiveSha256: sha256(data.archive?.sha256) };
  }
  if (channel === 'ios') {
    check(typeof data.build === 'string' && /^\d+$/.test(data.build), 'Invalid pinned iOS build');
    return { version: version(data.version), build: data.build };
  }
  if (channel === 'android') return { version: version(data.desktopVersion) };
  check(typeof data.archive?.version === 'string' && data.archive.version.length > 0 &&
    typeof data.box?.localTag === 'string' && data.box.localTag.length > 0 &&
    typeof data.box.platform === 'string' && data.box.platform.length > 0, 'Missing cloud input pins');
  for (const key of ['manifestDigest', 'configDigest']) {
    check(/^sha256:[0-9a-f]{64}$/.test(data.box[key]), `Invalid Box ${key}`);
  }
  return { host: { version: data.archive.version, archiveSha256: sha256(data.archive.sha256) },
    box: { localTag: data.box.localTag, platform: data.box.platform,
      manifestDigest: data.box.manifestDigest, configDigest: data.box.configDigest } };
}

// One GET, no redirects or retries. Count decoded bytes too (Content-Length may be absent or compressed).
async function metadata(channel, fetchImpl, deadline) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline);
  try {
    let response;
    try {
      response = await fetchImpl(feeds[channel], { method: 'GET', redirect: 'error', credentials: 'omit',
        cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal });
    } catch {
      throw new Error('Public metadata request failed');
    }
    check(response.status === 200, `Metadata endpoint returned HTTP ${response.status}`);
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    // Apple's lookup serves plain JSON with a JavaScript MIME type; never evaluate it.
    check(type === 'application/json' || (channel === 'ios' && type === 'text/javascript'),
      'Expected JSON metadata content type');
    check(!(Number(response.headers.get('content-length')) > maxBytes), 'Metadata exceeds byte limit');
    check(response.body, 'Missing metadata body');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      check(total <= maxBytes, 'Metadata exceeds byte limit');
      chunks.push(chunk);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
    } catch {
      throw new Error('Invalid UTF-8 or JSON metadata');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Public metadata request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function observe(channel, fetchImpl, deadline) {
  const record = { source: feeds[channel], reference: channel === 'ios' ? iosListing : desktopDocs,
    pinFile: pins[channel], pinned: null, observed: null, comparison: null };
  try {
    record.pinned = await readPin(channel);
    const data = await metadata(channel, fetchImpl, deadline);
    const observed = channel === 'ios' ? iosObservation(data) : desktopObservation(channel, data);
    record.observed = observed;
    const comparison = { version: compareVersion(observed.version, record.pinned.version),
      archiveSha256: 'not-published' };
    if (channel === 'ios') comparison.build = 'not-published';
    else {
      comparison.archiveUrl = observed.downloadUrl === record.pinned.archiveUrl ? 'same' : 'different';
      if (observed.publishedArchiveSha256 !== null) {
        comparison.archiveSha256 = comparison.archiveUrl !== 'same' ? 'different-artifact'
          : observed.publishedArchiveSha256 === record.pinned.archiveSha256 ? 'same' : 'mismatch';
      }
    }
    record.comparison = comparison;
    check(comparison.archiveSha256 !== 'mismatch', 'Published SHA-256 conflicts with the pin for the same artifact');
    return { ...record, status: 'observed' };
  } catch (error) {
    return { ...record, status: 'error', error: error.message };
  }
}

export async function discover({ phase = 'manual', fetchImpl = globalThis.fetch, deadline = timeoutMs } = {}) {
  check(Number.isSafeInteger(deadline) && deadline > 0 && deadline <= timeoutMs, 'Invalid request deadline');
  const checkedAt = new Date().toISOString();
  const [windows, mac, ios] = await Promise.all(Object.keys(feeds).map(k => observe(k, fetchImpl, deadline)));
  const channels = { windows, mac, ios };
  const renderer = { sourceChannel: 'windows', pinFile: pins.android, pinned: null, comparison: null };
  try {
    renderer.pinned = await readPin('android');
    if (windows.status === 'observed') {
      renderer.status = 'derived';
      renderer.comparison = { version: compareVersion(windows.observed.version, renderer.pinned.version) };
    } else renderer.status = 'source-unavailable';
  } catch (error) {
    Object.assign(renderer, { status: 'error', error: error.message });
  }
  channels.androidRenderer = renderer;
  const cloud = { source: null, pinFile: pins.cloud, observed: null, comparison: null };
  try {
    const pinned = await readPin('cloud');
    for (const key of ['host', 'box']) channels[key] = { ...cloud, status: 'not-discovered',
      reason: 'No documented public latest channel used; local pin only', pinned: pinned[key] };
  } catch (error) {
    for (const key of ['host', 'box']) channels[key] = { ...cloud, status: 'error', pinned: null, error: error.message };
  }
  return { schema: 'prokbot-official-channels/v1', checkedAt, phase,
    ok: Object.values(channels).every(item => item.status !== 'error'), artifactsVerified: false, channels };
}

const usage = 'Usage: node ci/official-channels.mjs --online [--phase planning|pre-release]\n' +
  'Run once when planning and again before release. Outputs JSON to stdout; never downloads artifacts or edits pins.\n';

export async function main(args, { fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    stdout.write(usage);
    return 0;
  }
  if (args[0] !== '--online' || !(args.length === 1 || (args.length === 3 && args[1] === '--phase' &&
    ['planning', 'pre-release'].includes(args[2])))) {
    stderr.write(usage);
    return 2;
  }
  const report = await discover({ phase: args[2], fetchImpl });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
