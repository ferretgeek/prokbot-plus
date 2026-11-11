import assert from 'node:assert/strict';
import test from 'node:test';
import { Auth } from '../server/auth.mjs';
import { PushService } from '../server/push-service.mjs';

function memory(store) {
  store.value = structuredClone(store.initial);
  store.mutate = async update => update(store.value);
}

test('Android pairings do not gain desktop execution rights; display metadata preserves older clients', async () => {
  const auth = new Auth('.'); memory(auth.store);
  const push = new PushService('.', auth); memory(push.store);
  for (const [kind, platform, label] of [['android', 'android', 'android'], ['windows', 'desktop', 'windows'], [undefined, 'desktop', 'desktop']]) {
    const { pairingKey } = await auth.createPairing();
    const { token, deviceId } = await auth.pair({ platform: 'desktop', deviceName: 'demo', clientKind: kind, pairingKey });
    assert.equal(auth.authenticate(token).platform, platform);
    await push.register(deviceId, { kind: 'desktop', clientKind: kind });
    assert.equal(push.get(deviceId).kind, label);
  }
});
