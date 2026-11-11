import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { postWithFallback } from '../runtime/model-common.mjs';

test('model requests never forward credentials or conversation bodies through a redirect', async t => {
  async function listen(handler) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    return `http://127.0.0.1:${server.address().port}`;
  }
  let hits = 0;
  const other = await listen((_req, res) => { hits++; res.end('unexpected'); });
  const url = await listen((_req, res) => { res.writeHead(307, { location: other }); res.end(); });
  await assert.rejects(postWithFallback({ fetchImpl: fetch, url, headers: { 'x-api-key': 'test-only' },
    build: () => ({ messages: ['private'] }), state: { dropped: new Set() } }));
  assert.equal(hits, 0);
});
