import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsBackup, restoreSettingsBackup, parseSettingsBackup, validateSettingsBackup, BACKUP_MAX_BYTES } from '../src/services/settings-backup.js';
import { getSettings, SETTINGS_KEYS } from '../src/services/storage.js';
let data, writes, failWrite;
const document = (extra = {}) => ({ schema: 'StreamDropsHubSettings', schemaVersion: 1,
  extensionVersion: '1.5.36', exportedAt: '2026-10-03T06:00:00+09:00', settings: { pollingIntervalMinutes: 5, collectorFailureAlerts: true },
  hiddenRewards: [{ id: 'chzzk_1', platform: 'chzzk', rewardName: 'Reward' }], ...extra });
beforeEach(() => {
  data = { settings: { autoCollectChzzk: true, privateSetting: 'SECRET-SETTING' },
    'hidden:chzzk_1': { id: 'chzzk_1', platform: 'chzzk', rewardName: 'Original', hiddenAt: 123, couponCode: 'SECRET-COUPON', twitchUserId: 'SECRET-ACCOUNT' },
    'handled:twitch_claimed': { id: 'twitch_claimed', couponCode: 'SECRET-HISTORY' }, 'coupon:1': 'SECRET-CODE',
    collectorState: { twitch: { twitchUserId: 'SECRET-ID' } }, authToken: 'SECRET-TOKEN', claimRetries: { 1: 'KEEP' } };
  writes = 0; failWrite = false;
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '1.5.36' }) }, storage: { local: {
    async get(keys) { return keys == null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
    async set(values) { if (failWrite) throw Error('quota'); writes++; Object.assign(data, structuredClone(values)); },
  } } };
});

test('backup exports known options and minimal hidden metadata without credentials, coupons, receipts, cache or runtime state', async () => {
  const exported = await createSettingsBackup();
  assert.equal(exported.schemaVersion, 1); assert.equal(Object.keys(exported.settings).length, SETTINGS_KEYS.length);
  assert.equal(exported.hiddenRewards[0].rewardName, 'Original');
  assert.equal(/SECRET|collectorState|handled:|claimRetries|authToken|couponCode|twitchUserId/.test(JSON.stringify(exported)), false);
  assert.equal(writes, 0);
  assert.deepEqual(parseSettingsBackup('\uFEFF' + JSON.stringify(exported)), exported);
});
test('restore applies selected options and merges hidden rewards without overwriting existing metadata or historical/runtime data', async () => {
  const before = structuredClone(data);
  const backup = document({ hiddenRewards: [
    { id: 'chzzk_1', platform: 'chzzk', rewardName: 'Replacement' },
    { id: 'twitch_new', platform: 'twitch', rewardName: 'New', rewardImageUrl: 'https://example.test/image.png' },
  ] });
  const result = await restoreSettingsBackup(backup);
  assert.equal(result.hiddenAdded, 1); assert.equal(result.hiddenTotal, 2); assert.equal(writes, 1);
  assert.equal((await getSettings()).pollingIntervalMinutes, 5); assert.equal((await getSettings()).collectorFailureAlerts, true);
  assert.equal((await getSettings()).autoCollectChzzk, true);
  assert.deepEqual(data['hidden:chzzk_1'], before['hidden:chzzk_1']);
  for (const key of ['handled:twitch_claimed', 'coupon:1', 'collectorState', 'authToken', 'claimRetries']) assert.deepEqual(data[key], before[key]);
  assert.equal(data.settings.privateSetting, 'SECRET-SETTING');
});
test('malformed JSON, future schema, unknown settings, invalid options and prototype payloads are rejected before any write', async () => {
  assert.throws(() => parseSettingsBackup('{'), /JSON/);
  const invalid = [document({ schemaVersion: 2 }), document({ settings: { pollingIntervalMinutes: 1 } }),
    document({ settings: { autoClaim: 'true' } }), document({ settings: { autoCollectSoop: true } }),
    document({ settings: { chzzkCollectCampaign: 'javascript:alert(1)' } }), document({ settings: {} }),
    document({ authToken: 'secret' }), document({ settings: JSON.parse('{"__proto__":{"polluted":true}}') }),
    document({ hiddenRewards: [{ id: '__proto__', platform: 'chzzk' }] }),
    document({ hiddenRewards: [{ id: 'chzzk_1', platform: 'twitch' }] }),
    document({ hiddenRewards: [{ id: 'chzzk_1', platform: 'chzzk', couponCode: 'secret' }] }),
    document({ hiddenRewards: [{ id: 'chzzk_1', platform: 'chzzk', rewardImageUrl: 'javascript:alert(1)' }] }),
    document({ hiddenRewards: [{ id: 'chzzk_1', platform: 'chzzk', rewardImageUrl: 'https://user:password@example.test/' }] }),
  ];
  const before = structuredClone(data);
  for (const value of invalid) await assert.rejects(restoreSettingsBackup(value));
  assert.equal(writes, 0); assert.deepEqual(data, before); assert.equal({}.polluted, undefined);
});
test('oversized files and too many hidden rewards fail without writes', async () => {
  assert.throws(() => parseSettingsBackup(' '.repeat(BACKUP_MAX_BYTES + 1)), /1MB/);
  await assert.rejects(restoreSettingsBackup(document({ hiddenRewards: Array.from({ length: 2001 }, (_, i) => ({ id: 'chzzk_' + i, platform: 'chzzk' })) })));
  assert.equal(writes, 0);
});
test('duplicate hidden IDs are merged once and repeated import remains idempotent', async () => {
  const value = document({ hiddenRewards: [{ id: 'soop_2', platform: 'soop' }, { id: 'soop_2', platform: 'soop' }] });
  assert.equal(validateSettingsBackup(value).hiddenRewards.length, 1);
  assert.equal((await restoreSettingsBackup(value)).hiddenAdded, 1);
  assert.equal((await restoreSettingsBackup(value)).hiddenAdded, 0);
  assert.equal(Object.keys(data).filter(key => key === 'hidden:soop_2').length, 1);
});
test('storage failure cannot partially restore options or hidden preferences', async () => {
  failWrite = true; const before = structuredClone(data);
  await assert.rejects(restoreSettingsBackup(document({ hiddenRewards: [{ id: 'soop_new', platform: 'soop' }] })), /quota/);
  assert.equal(writes, 0); assert.deepEqual(data, before);
});
test('unsafe legacy thumbnails are omitted from export instead of breaking a valid settings backup', async () => {
  data['hidden:chzzk_1'].rewardImageUrl = 'javascript:alert(1)';
  const backup = await createSettingsBackup();
  assert.equal(backup.hiddenRewards[0].rewardImageUrl, undefined);
  assert.equal(backup.hiddenRewards[0].rewardName, 'Original');
});