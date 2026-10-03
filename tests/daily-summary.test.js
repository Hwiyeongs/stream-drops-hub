import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailySummary, getDailySummary } from '../src/services/daily-summary.js';
const now = Date.parse('2026-10-03T06:00:00+09:00');
const beforeReset = Date.parse('2026-10-03T04:59:00+09:00');
const afterReset = Date.parse('2026-10-03T05:00:00+09:00');
const drop = (id, platform = 'chzzk', extra = {}) => ({ id, platform, claimable: true, acquiredAt: afterReset, ...extra });
const cached = drops => ({ drops, lastUpdated: now, platformStatuses: { chzzk: { loggedIn: true }, soop: { loggedIn: true }, twitch: { loggedIn: true } } });

test('05:00 is the exact day boundary; confirmed acquisition and processed rewards are counted once', () => {
  const a = drop('chzzk_a');
  const summary = buildDailySummary({ now, cached: cached([a, drop('chzzk_b', 'chzzk', { acquiredAt: beforeReset })]),
    handled: { chzzk_a: { ...a, actionType: 'saved', receivedAt: afterReset } } });
  assert.equal(summary.day, '2026-10-03');
  assert.equal(summary.platforms.chzzk.earnedToday, 1);
  assert.equal(summary.platforms.chzzk.processedToday, 1);
  assert.equal(summary.platforms.chzzk.pending, 1);
  const earlier = buildDailySummary({ now: beforeReset, cached: cached([drop('chzzk_b', 'chzzk', { acquiredAt: beforeReset })]) });
  assert.equal(earlier.day, '2026-10-02'); assert.equal(earlier.platforms.chzzk.earnedToday, 1);
});
test('Twitch only counts known account receipts and confirmed original dates; duplicates and other accounts cannot inflate today', () => {
  const receipt = { id: 'twitch_first', platform: 'twitch', dropInstanceId: 'instance', twitchUserId: 'viewer',
    actionType: 'claimed', claimedAt: afterReset, receivedAt: now };
  const summary = buildDailySummary({ now, accounts: { twitch: 'viewer' }, cached: cached([]), handled: {
    first: receipt, duplicate: { ...receipt, id: 'twitch_duplicate' }, other: { ...receipt, twitchUserId: 'other' },
    old: { ...receipt, id: 'old', dropInstanceId: 'old', claimedAt: beforeReset },
    already: { ...receipt, id: 'already', dropInstanceId: 'already', claimedAt: null, claimStatus: 'DROP_INSTANCE_ALREADY_CLAIMED' },
    unverified: { ...receipt, id: 'unverified', dropInstanceId: 'unverified', claimedAt: null },
  } });
  assert.equal(summary.platforms.twitch.processedToday, 1); assert.equal(summary.platforms.twitch.earnedToday, null);
});
test('unknown acquisition times never use a campaign date or first discovery as proof of earning today', () => {
  const summary = buildDailySummary({ now, cached: cached([
    drop('chzzk_unknown', 'chzzk', { acquiredAt: null, campaignDate: afterReset }),
    drop('soop_unknown', 'soop', { recentDate: afterReset }), drop('twitch_unknown', 'twitch', { campaignDate: afterReset }),
  ]) });
  assert.equal(summary.platforms.chzzk.earnedToday, null); assert.equal(summary.platforms.soop.earnedToday, 1);
  assert.equal(summary.platforms.twitch.earnedToday, null); assert.equal(summary.platforms.twitch.processedToday, null);
});
test('hidden, handled and expired rewards are excluded from waiting; pending earned Twitch drops survive campaign end', () => {
  const summary = buildDailySummary({ now, cached: cached([drop('hidden'), drop('handled'),
    drop('expired', 'chzzk', { expDate: '2020-01-01' }), drop('twitch_old', 'twitch', { expDate: '2020-01-01' }),
    drop('future', 'chzzk', { acquiredAt: now + 60000 })]),
    hidden: { hidden: {} }, handled: { handled: { ...drop('handled'), actionType: 'saved', receivedAt: beforeReset } } });
  assert.equal(summary.platforms.chzzk.pending, 1); assert.equal(summary.platforms.twitch.pending, 1);
  assert.equal(summary.platforms.chzzk.earnedToday, 2); // expired acquisition and previously handled acquisition remain confirmed facts
});
test('last successful inventory time survives a failed poll; unknown or logged-out data is marked unverified', () => {
  const summary = buildDailySummary({ now, cached: { drops: [], lastUpdated: now, platformStatuses: {
    chzzk: { loggedIn: null, error: 'PRIVATE' }, twitch: { loggedIn: false } } },
    lastSuccess: { chzzk: afterReset, soop: now + 1 }, accounts: { twitch: 'viewer' },
    collectorState: { twitch: { twitchUserId: 'viewer' } } });
  assert.equal(summary.platforms.chzzk.state, 'stale'); assert.equal(summary.platforms.chzzk.lastSuccessAt, afterReset);
  assert.equal(summary.platforms.soop.state, 'unknown'); assert.equal(summary.platforms.soop.lastSuccessAt, null);
  assert.equal(summary.platforms.twitch.state, 'login'); assert.equal(summary.platforms.twitch.processedToday, null);
  const unverified = buildDailySummary({ now, accounts: { twitch: 'previous' }, collectorState: { twitch: { twitchUserId: 'previous', campaignsCheckedAt: beforeReset } } });
  assert.equal(unverified.platforms.twitch.processedToday, null);
});
test('summary reports counts and timestamps only, without account IDs, coupon codes, URLs or error text', async () => {
  const values = { dropsCache: [drop('PRIVATE-ID')], lastUpdated: now, platformStatuses: { chzzk: { loggedIn: true } },
    inventoryAccounts: { twitch: 'PRIVATE-ACCOUNT' }, 'handled:secret': { ...drop('secret'), couponCode: 'PRIVATE-CODE',
      actionType: 'saved', receivedAt: afterReset, campaignUrl: 'PRIVATE-URL' } };
  globalThis.chrome = { storage: { local: { async get(keys) { return keys == null ? structuredClone(values) : Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(values[key])]) ); } } } };
  const summary = await getDailySummary(now);
  assert.equal(/PRIVATE/.test(JSON.stringify(summary)), false); assert.equal(summary.platforms.chzzk.processedToday, 1);
});
test('earning today includes unclaimed rewards and ignores later claim or code-copy dates on every platform', () => {
  const input = { now, accounts: { twitch: 'viewer' }, cached: cached([
    drop('new', 'chzzk'), drop('soop_today', 'soop'),
    drop('twitch_today', 'twitch', { twitchUserId: 'viewer', campaignId: 'c', timeBasedDropId: 'd', dropInstanceId: 'today' }),
  ]), handled: {
    oldChzzk: { ...drop('oldChzzk'), acquiredAt: beforeReset, receivedAt: now, actionType: 'copied' },
    oldSoop: { ...drop('oldSoop', 'soop'), acquiredAt: beforeReset, receivedAt: now, actionType: 'saved' },
    oldTwitch: { ...drop('oldTwitch', 'twitch'), acquiredAt: beforeReset, claimedAt: now, twitchUserId: 'viewer', actionType: 'claimed' },
  } };
  const summary = buildDailySummary(input);
  for (const platform of ['chzzk', 'soop', 'twitch']) assert.equal(summary.platforms[platform].earnedToday, 1);
  const acquired = input.cached.drops[0];
  input.handled.new = { ...acquired, actionType: 'saved', receivedAt: now }; input.cached.drops.shift();
  assert.equal(buildDailySummary(input).platforms.chzzk.earnedToday, 1);
});
test('SOOP reward title and recentDate never replace a missing acquisition timestamp', () => {
  const summary = buildDailySummary({ now, cached: cached([drop('soop_unknown', 'soop', { acquiredAt: null, recentDate: afterReset, campaignDate: afterReset })]) });
  assert.equal(summary.platforms.soop.earnedToday, null);
});
test('Twitch progress acquisition records survive claims and account changes without counting other accounts or hidden rewards', () => {
  const acquired = drop('twitch_today', 'twitch', { twitchUserId: 'viewer', campaignId: 'c', timeBasedDropId: 'd', dropInstanceId: 'today' });
  const summary = buildDailySummary({ now, accounts: { twitch: 'viewer' }, cached: cached([acquired]), acquisitions: [
    acquired, { ...acquired, id: 'twitch_other', twitchUserId: 'other', dropInstanceId: 'other' },
    { ...acquired, id: 'twitch_hidden', timeBasedDropId: 'hidden', dropInstanceId: 'hidden' },
  ], hidden: { twitch_hidden: {} }, handled: { receipt: { ...acquired, acquiredAt: null, claimedAt: now, actionType: 'claimed' } } });
  assert.equal(summary.platforms.twitch.earnedToday, 1);
  assert.equal(buildDailySummary({ now, accounts: { twitch: 'new' }, cached: cached([]), acquisitions: [acquired] }).platforms.twitch.earnedToday, 0);
});
