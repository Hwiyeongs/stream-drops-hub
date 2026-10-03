import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { observeTwitchAcquisitions, acquisitionRecords } from '../src/services/reward-acquisition.js';
let data, failWrite;
const start = Date.parse('2026-10-03T05:10:00+09:00');
const campaigns = (watched, extra = {}) => [{ id: 'campaign', timeBasedDrops: [{ id: 'drop', requiredMinutesWatched: 60,
  self: { currentMinutesWatched: watched, isClaimed: false, dropInstanceID: watched >= 60 ? 'instance' : null, ...extra } }] }];
beforeEach(() => {
  data = {}; failWrite = false;
  globalThis.chrome = { storage: { local: { async get() { return structuredClone(data); }, async set(values) {
    if (failWrite) throw Error('quota'); Object.assign(data, structuredClone(values));
  } } } };
});
test('incomplete to completed server progress is recorded before claim and remains unchanged after claim/reload', async () => {
  await observeTwitchAcquisitions(campaigns(59), 'viewer', start);
  const earnedAt = start + 60000;
  const result = await observeTwitchAcquisitions(campaigns(60), 'viewer', earnedAt);
  assert.equal(result[0].timeBasedDrops[0].acquiredAt, earnedAt);
  assert.equal(acquisitionRecords(data)[0].acquiredAt, earnedAt);
  await observeTwitchAcquisitions(campaigns(0, { isClaimed: true, dropInstanceID: 'instance' }), 'viewer', earnedAt + 86400000);
  assert.equal(acquisitionRecords(data)[0].acquiredAt, earnedAt);
});
test('initially completed inventory never assigns today from discovery, campaign title, or claimed state', async () => {
  const result = await observeTwitchAcquisitions(campaigns(60), 'viewer', start);
  assert.equal(result[0].timeBasedDrops[0].acquiredAt, null);
  await observeTwitchAcquisitions(campaigns(0, { isClaimed: true }), 'viewer', start + 60000);
  assert.equal(acquisitionRecords(data)[0].acquiredAt, null);
});
test('05:00-crossing completion and a clock reversal cannot establish a new acquisition day', async () => {
  const before = Date.parse('2026-10-03T04:59:00+09:00');
  await observeTwitchAcquisitions(campaigns(59), 'viewer', before);
  assert.equal((await observeTwitchAcquisitions(campaigns(60), 'viewer', start))[0].timeBasedDrops[0].acquiredAt, null);
  data = {}; await observeTwitchAcquisitions(campaigns(59), 'viewer', start + 60000);
  assert.equal((await observeTwitchAcquisitions(campaigns(60), 'viewer', start))[0].timeBasedDrops[0].acquiredAt, null);
});
test('accounts and changed instances cannot reuse another acquisition timestamp or baseline', async () => {
  await observeTwitchAcquisitions(campaigns(59), 'one', start);
  assert.equal((await observeTwitchAcquisitions(campaigns(60), 'two', start + 1))[0].timeBasedDrops[0].acquiredAt, null);
  await observeTwitchAcquisitions(campaigns(60), 'one', start + 2);
  const changed = await observeTwitchAcquisitions(campaigns(60, { dropInstanceID: 'other' }), 'one', start + 3);
  assert.equal(changed[0].timeBasedDrops[0].acquiredAt, null);
});
test('missing progress never creates a false incomplete baseline; incomplete observations are excluded from summary records', async () => {
  await observeTwitchAcquisitions(campaigns(null), 'viewer', start);
  assert.deepEqual(acquisitionRecords(data), []);
  assert.equal((await observeTwitchAcquisitions(campaigns(60), 'viewer', start + 1))[0].timeBasedDrops[0].acquiredAt, null);
  data = {}; await observeTwitchAcquisitions(campaigns(59), 'viewer', start);
  assert.deepEqual(acquisitionRecords(data), []);
});
test('concurrent observers preserve independent rewards and rejected storage writes do not poison later observations', async () => {
  await Promise.all([observeTwitchAcquisitions(campaigns(59), 'one', start), observeTwitchAcquisitions(campaigns(59), 'two', start)]);
  await Promise.all([observeTwitchAcquisitions(campaigns(60), 'one', start + 1), observeTwitchAcquisitions(campaigns(60), 'two', start + 1)]);
  assert.equal(acquisitionRecords(data).length, 2);
  failWrite = true; await assert.rejects(observeTwitchAcquisitions(campaigns(0), 'three', start), /quota/);
  failWrite = false; await observeTwitchAcquisitions(campaigns(59), 'three', start);
  await observeTwitchAcquisitions(campaigns(60), 'three', start + 1);
  assert.equal(acquisitionRecords(data).length, 3);
});

test('a previously claimed exact reward cannot gain a new acquisition date when server progress recovers from zero', async () => {
  data['handled:old'] = { platform: 'twitch', twitchUserId: 'viewer', campaignId: 'campaign', timeBasedDropId: 'drop',
    dropInstanceId: 'instance', actionType: 'claimed', claimedAt: start - 86400000 };
  await observeTwitchAcquisitions(campaigns(0), 'viewer', start);
  const result = await observeTwitchAcquisitions(campaigns(60), 'viewer', start + 1);
  assert.equal(result[0].timeBasedDrops[0].acquiredAt, null);
});
test('an exact receipt preserves its recorded acquisition time while a different instance does not inherit it', async () => {
  data['handled:old'] = { platform: 'twitch', twitchUserId: 'viewer', campaignId: 'campaign', timeBasedDropId: 'drop',
    dropInstanceId: 'instance', actionType: 'claimed', acquiredAt: start - 86400000 };
  assert.equal((await observeTwitchAcquisitions(campaigns(60), 'viewer', start))[0].timeBasedDrops[0].acquiredAt, start - 86400000);
  assert.equal((await observeTwitchAcquisitions(campaigns(60, { dropInstanceID: 'different' }), 'viewer', start + 1))[0].timeBasedDrops[0].acquiredAt, null);
});
