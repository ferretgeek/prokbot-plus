import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { discover, main } from './official-channels.mjs';

const urls = {
  windows: 'https://api2.cursor.sh/updates/api/download/stable/win32-x64-user/sand',
  mac: 'https://api2.cursor.sh/updates/api/download/stable/darwin-arm64/sand',
  ios: 'https://itunes.apple.com/lookup?id=6794501026&country=us',
};
const pin = async path => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
const [win, mac, ios, android] = await Promise.all([
  'windows/patchers/desktop/supported.json', 'mac/patchers/desktop/supported.json',
  'ios/recipes/ios/manifest.json', 'android/patchers/supported.json',
].map(pin));
const buildId = 'abc1'.repeat(10);
const listing = 'https://apps.apple.com/us/app/grok-bot/id6794501026';
const json = (value, type = 'application/json') => new Response(JSON.stringify(value),
  { headers: { 'content-type': `${type}; charset=utf-8` } });

function desktop(channel, release = (channel === 'windows' ? win : mac).version) {
  const path = channel === 'windows' ? `win32-x64/${release}/Grok_Bot_${release}_Setup.exe`
    : `darwin-arm64/${release}/Grok_Bot_${release}.dmg`;
  return { version: release, downloadUrl: `https://downloads.cursor.com/grokbot/stable/${path}`,
    commitSha: buildId, rehUrl: 'https://example.invalid/ignored-archive.tar.gz' };
}

function apple(fields = {}) {
  return { resultCount: 1, results: [{ kind: 'software', wrapperType: 'software', trackId: 6794501026,
    bundleId: 'co.anysphere.sand', trackName: 'Grok Bot', trackViewUrl: `${listing}?uo=4`,
    currentVersionReleaseDate: '2025-11-11T05:47:21Z', version: ios.version, ...fields }] };
}

// Unknown URLs are test failures, not fallbacks to the network. Each call gets its own body.
function fakeFeeds(overrides = {}) {
  const calls = [];
  return { calls, async fetchImpl(url, options) {
    calls.push({ url, options });
    const channel = Object.keys(urls).find(k => urls[k] === url);
    assert.ok(channel, `Unexpected request: ${url}`);
    if (overrides[channel]) return overrides[channel](options);
    return channel === 'ios' ? json(apple(), 'text/javascript') : json(desktop(channel));
  } };
}

async function cli(args, fixtures) {
  let stdout = '', stderr = '';
  const code = await main(args, { fetchImpl: fixtures.fetchImpl,
    stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
  return { code, stdout, stderr };
}

test('offline by default, help or invalid options never start discovery', async () => {
  const fixtures = fakeFeeds();
  for (const args of [[], ['--help'], ['--phase', 'planning'], ['--online', '--phase', 'other'],
    ['--online', '--help'], ['--online', 'https://example.invalid']]) {
    const out = await cli(args, fixtures);
    assert.equal(out.code, args[0] === '--help' ? 0 : 2);
    assert.match(out.stdout || out.stderr, /--online/);
  }
  assert.equal(fixtures.calls.length, 0);
});

test('both release checks produce timestamped JSON from only three anonymous metadata GETs', async () => {
  const fixtures = fakeFeeds();
  for (const phase of ['planning', 'pre-release']) {
    const out = await cli(['--online', '--phase', phase], fixtures);
    assert.equal(out.code, 0);
    assert.equal(out.stderr, '');
    const { schema, checkedAt, phase: label, ok, artifactsVerified, channels } = JSON.parse(out.stdout);
    assert.equal(schema, 'prokbot-official-channels/v1');
    assert.equal(new Date(checkedAt).toISOString(), checkedAt);
    assert.equal(label, phase);
    assert.equal(ok, true);
    assert.equal(artifactsVerified, false);
    for (const [key, local] of [['windows', win], ['mac', mac]]) {
      const item = channels[key];
      assert.equal(item.source, urls[key]);
      assert.equal(item.pinned.version, local.version);
      assert.equal(item.pinned.archiveSha256, local.archive.sha256);
      assert.equal(item.observed.downloadUrl, local.archive.url);
      assert.equal(item.observed.buildId, buildId);
      assert.equal(item.observed.buildIdField, 'commitSha');
      assert.equal(item.observed.publishedArchiveSha256, null);
      assert.deepEqual(item.comparison, { version: 'same', archiveUrl: 'same', archiveSha256: 'not-published' });
    }
    assert.deepEqual(channels.ios.pinned, { version: ios.version, build: ios.build });
    assert.equal(channels.ios.observed.build, null);
    assert.equal(channels.ios.observed.publishedArchiveSha256, null);
    assert.equal(channels.ios.observed.listingUrl, listing);
    assert.deepEqual(channels.ios.comparison, { version: 'same', build: 'not-published', archiveSha256: 'not-published' });
    assert.equal(channels.androidRenderer.sourceChannel, 'windows');
    assert.equal(channels.androidRenderer.status, 'derived');
    assert.equal(channels.androidRenderer.pinned.version, android.desktopVersion);
    for (const key of ['host', 'box']) {
      assert.equal(channels[key].status, 'not-discovered');
      assert.equal(channels[key].source, null);
      assert.equal(channels[key].observed, null);
      assert.equal(channels[key].comparison, null);
      assert.ok(channels[key].pinned);
    }
    assert.deepEqual(fixtures.calls.slice(-3).map(x => x.url).sort(), Object.values(urls).sort());
  }
  assert.equal(fixtures.calls.length, 6);
  for (const { options } of fixtures.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('numeric version drift is informational; an explicit checksum is compared only for the same artifact', async () => {
  const newer = `${Number(win.version.split('.')[0]) + 10}.0.0`;
  const fixtures = fakeFeeds({ windows: () => json({ ...desktop('windows', newer), sha256: 'a'.repeat(64) }),
    mac: () => json({ ...desktop('mac'), sha256: mac.archive.sha256.toUpperCase() }),
    ios: () => json(apple({ version: '0.0.0' })) });
  const out = await cli(['--online'], fixtures);
  assert.equal(out.code, 0);
  const { channels, phase, artifactsVerified } = JSON.parse(out.stdout);
  assert.equal(phase, 'manual');
  assert.equal(channels.windows.comparison.version, 'newer');
  assert.equal(channels.windows.comparison.archiveSha256, 'different-artifact');
  assert.equal(channels.androidRenderer.comparison.version, 'newer');
  assert.equal(channels.mac.comparison.archiveSha256, 'same');
  assert.equal(channels.ios.comparison.version, 'older');
  assert.equal(artifactsVerified, false);

  const mismatch = (win.archive.sha256[0] === 'a' ? 'b' : 'a').repeat(64);
  const conflict = await cli(['--online'], fakeFeeds({ windows: () => json({ ...desktop('windows'), sha256: mismatch }) }));
  assert.equal(conflict.code, 1);
  const item = JSON.parse(conflict.stdout).channels.windows;
  assert.equal(item.comparison.archiveSha256, 'mismatch');
  assert.equal(item.observed.publishedArchiveSha256, mismatch);
  assert.equal(item.pinned.archiveSha256, win.archive.sha256);
});

test('desktop rejects another product, platform, version, origin, or malformed release fields', async t => {
  const valid = desktop('windows');
  const cases = {
    'another product': { downloadUrl: valid.downloadUrl.replace('Grok_Bot_', 'Cursor_') },
    'other architecture': { downloadUrl: valid.downloadUrl.replace('win32-x64', 'win32-arm64') },
    'other platform': { downloadUrl: desktop('mac').downloadUrl },
    'different version in URL': { version: valid.version === '2.0.0' ? '3.0.0' : '2.0.0' },
    'another origin': { downloadUrl: valid.downloadUrl.replace('downloads.cursor.com', 'example.invalid') },
    'prerelease version': { version: '1.0.0-beta' }, 'non-string version': { version: 1 },
    'missing commitSha': { commitSha: null }, 'checksum used as build ID': { commitSha: 'c'.repeat(64) },
    'build ID used as checksum': { sha256: buildId }, 'null checksum': { sha256: null },
  };
  for (const [name, fields] of Object.entries(cases)) await t.test(name, async () => {
    const { ok, channels } = await discover(fakeFeeds({ windows: () => json({ ...valid, ...fields }) }));
    assert.equal(ok, false);
    assert.equal(channels.windows.status, 'error');
    assert.equal(channels.windows.observed, null);
    assert.equal(channels.androidRenderer.status, 'source-unavailable');
    assert.equal(channels.mac.status, 'observed');
    assert.equal(channels.ios.status, 'observed');
  });
});

test('Apple lookup must be exactly the US Grok Bot software record, not a similar name or bundle', async t => {
  const cases = {
    'no results': { resultCount: 0, results: [] }, 'incorrect count': { ...apple(), resultCount: 2 },
    'ambiguous results': { ...apple(), results: [...apple().results, ...apple().results] },
    'different ID': apple({ trackId: 1 }), 'different bundle': apple({ bundleId: 'com.anysphere.sand' }),
    'wrong name': apple({ trackName: 'Grok' }), 'wrong media type': apple({ kind: 'song' }),
    'other storefront': apple({ trackViewUrl: listing.replace('/us/', '/gb/') }),
    'bad version': apple({ version: '' }), 'impossible date': apple({ currentVersionReleaseDate: '2025-02-30T00:00:00Z' }),
  };
  for (const [name, data] of Object.entries(cases)) await t.test(name, async () => {
    const out = await cli(['--online'], fakeFeeds({ ios: () => json(data, 'text/javascript') }));
    assert.equal(out.code, 1);
    const { ok, channels } = JSON.parse(out.stdout);
    assert.equal(ok, false);
    assert.equal(channels.ios.observed, null);
    assert.equal(channels.ios.status, 'error');
    assert.equal(channels.windows.status, 'observed');
    assert.equal(channels.mac.status, 'observed');
  });
});

test('failed or malformed responses retain the other evidence and exit nonzero without retries', async t => {
  const headers = { 'content-type': 'application/json' };
  const cases = {
    'network failure': [() => { throw new Error('fixture connection failure'); }, /request failed/],
    'HTTP error': [() => new Response('ignored', { status: 503 }), /HTTP 503/],
    'redirect': [() => Response.redirect(win.archive.url), /HTTP 302/],
    'binary content type': [() => new Response('{}', { headers: { 'content-type': 'application/octet-stream' } }), /content type/],
    'bad JSON': [() => new Response('{', { headers }), /JSON metadata/],
    'invalid UTF-8': [() => new Response(Uint8Array.of(0xff), { headers }), /UTF-8/],
    'excessive Content-Length': [() => new Response('{}', { headers: { ...headers, 'content-length': '999999' } }), /byte limit/],
    'oversized chunked body': [() => new Response(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array(80 * 1024)); c.enqueue(new Uint8Array(80 * 1024)); c.close();
    } }), { headers }), /byte limit/],
  };
  for (const [name, [response, message]] of Object.entries(cases)) await t.test(name, async () => {
    const fixtures = fakeFeeds({ mac: response });
    const out = await cli(['--online'], fixtures);
    assert.equal(out.code, 1);
    assert.equal(fixtures.calls.length, 3);
    const { ok, channels } = JSON.parse(out.stdout);
    assert.equal(ok, false);
    assert.equal(channels.mac.status, 'error');
    assert.match(channels.mac.error, message);
    assert.equal(channels.mac.pinned.version, mac.version);
    assert.equal(channels.mac.observed, null);
    assert.equal(channels.windows.status, 'observed');
    assert.equal(channels.ios.status, 'observed');
  });
});

test('request deadline covers a stalled response body', async () => {
  const fixtures = fakeFeeds({ mac: ({ signal }) => new Response(new ReadableStream({ start(c) {
    signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
  } }), { headers: { 'content-type': 'application/json' } }) });
  const { ok, channels } = await discover({ ...fixtures, deadline: 40 });
  assert.equal(ok, false);
  assert.match(channels.mac.error, /timed out/);
  assert.equal(channels.windows.status, 'observed');
  assert.equal(channels.ios.status, 'observed');
});
