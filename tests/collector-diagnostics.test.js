import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { inspectChzzkProgress } from '../src/services/collector-progress.js';
import { appendCollectorEvent, getCollectorEvents, getCollectorStatusReport, logCollectorTransition } from '../src/services/collector-diagnostics.js';

let data, failWrite;
beforeEach(() => {
  data = {}; failWrite = false;
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: 'test' }) },
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
      async set(values) { if (failWrite) throw Error('write failed'); Object.assign(data, structuredClone(values)); },
    } },
    tabs: { async get() { return { url: 'private-url', mutedInfo: { muted: true } }; } },
  };
});
const minute = 60000;
const campaign = (progressByReward = { first: 12 }, earned = 0) => ({ progressByReward, earned });
function stableSession() {
  return { progressAt: 0, lastProgressSampleAt: 9 * minute, lastRewardProgress: { first: 12 }, lastEarned: 0 };
}

test('CHZZK requires ten minutes of stable samples plus two minutes of successful rechecks', () => {
  const session = stableSession();
  assert.equal(inspectChzzkProgress(session, campaign(), true, 10 * minute), 'recheck');
  assert.equal(inspectChzzkProgress(session, campaign(), true, 11 * minute), 'recheck');
  assert.equal(inspectChzzkProgress(session, campaign(), true, 12 * minute), 'confirmed');
});
test('CHZZK sample gaps, unknown or partial progress, player failure and clock reversal cannot confirm a stall', () => {
  for (const [current, playing, now] of [
    [campaign(), true, 20 * minute], [campaign({ first: null }), true, 10 * minute],
    [campaign({ first: 12, second: null }), true, 10 * minute], [campaign(), false, 10 * minute],
    [campaign(), true, 8 * minute],
  ]) {
    const session = { ...stableSession(), stalledSince: 0 };
    assert.equal(inspectChzzkProgress(session, current, playing, now), null);
    assert.equal(session.stalledSince, undefined); assert.equal(session.progressAt, now);
  }
});
test('CHZZK reward increase, acquired tier and reduced/reset progress each restart observation', () => {
  for (const current of [campaign({ first: 13 }), campaign({ first: 12 }, 1), campaign({ first: 0 })]) {
    const session = { ...stableSession(), stalledSince: 0 };
    assert.equal(inspectChzzkProgress(session, current, true, 10 * minute), null);
    assert.equal(session.stalledSince, undefined);
  }
});
test('diagnostic writers serialize simultaneous events and retain only the last hundred', async () => {
  await Promise.all(Array.from({ length: 115 }, (_, i) => appendCollectorEvent('chzzk', 'progress', { minutes: i })));
  const events = await getCollectorEvents();
  assert.equal(events.length, 100); assert.equal(events[0].minutes, 15); assert.equal(events.at(-1).minutes, 114);
});
test('diagnostic retention excludes old, future and unknown events while preserving recent events across the daily reset', async () => {
  const now = Date.parse('2026-10-01T05:01:00+09:00');
  data.collectorEvents = [
    { platform: 'chzzk', type: 'playing', at: now - 8 * 86400000 },
    { platform: 'chzzk', type: 'unknown-type', at: now },
    { platform: 'chzzk', type: 'playing', at: now + 1 },
    { platform: 'chzzk', type: 'earned', at: now - 2 * minute },
  ];
  const events = await getCollectorEvents(now);
  assert.equal(events.length, 1); assert.equal(events[0].type, 'earned');
});
test('a failed diagnostic write does not reject collection and the queue remains usable', async () => {
  failWrite = true; await appendCollectorEvent('chzzk', 'playing');
  failWrite = false; await appendCollectorEvent('twitch', 'claimed');
  assert.equal((await getCollectorEvents()).length, 1);
});
test('common diagnostics whitelist status, error and playback fields and never copy raw secrets or IDs', async () => {
  const now = Date.now();
  data.settings = { autoCollectChzzk: true, autoCollectTwitch: true };
  data.collectorState = { chzzk: { phase: 'query_failed', error: 'PRIVATE-ERROR', status: 'PRIVATE-STATUS',
    queryReason: 'AUTH_REQUIRED', checkedAt: now, campaignsCheckedAt: now, tabId: 1, url: 'private-url',
    diagnostic: { state: 'blocked', reason: 'PRIVATE-REASON', headers: 'PRIVATE-HEADERS' },
    campaigns: [{ id: 'PRIVATE-CAMPAIGN-ID', title: 'Campaign', earned: 1, total: 3 }] },
    twitch: { twitchUserId: 'PRIVATE-ACCOUNT', url: 'PRIVATE-TWITCH-URL' } };
  data.collectorEvents = [{ at: now, platform: 'chzzk', type: 'query_failed', message: 'PRIVATE-MESSAGE',
    reason: 'PRIVATE-REASON', rawHeaders: 'PRIVATE-HEADERS', campaignId: 'PRIVATE-ID' }];
  const report = await getCollectorStatusReport(now);
  assert.equal(report.platforms.chzzk.queryReason, 'AUTH_REQUIRED');assert.equal(report.platforms.chzzk.stale, true);
  assert.equal(report.platforms.chzzk.tabOwned, true);assert.equal(report.platforms.chzzk.tabMuted, true);
  assert.equal(report.platforms.chzzk.playback.reason, null);assert.equal(report.platforms.twitch.playback.state, null);
  assert.equal(/PRIVATE|private-url/.test(JSON.stringify(report)), false);
});
test('a diagnostic report detects a user-navigated tab without inspecting or controlling another page', async () => {
  data.collectorState = { chzzk: { tabId: 1, url: 'other-url', campaignsCheckedAt: Date.now() } };
  const report = await getCollectorStatusReport();
  assert.equal(report.platforms.chzzk.tabOpen, true);assert.equal(report.platforms.chzzk.tabOwned, false);
});
test('stable status does not generate repeated events, while failure and recovery are traceable', async () => {
  const before = { phase: 'playing', campaignId: 'c', lastProgress: 10 };
  await logCollectorTransition('chzzk', before, { ...before });
  assert.equal((await getCollectorEvents()).length, 0);
  const failed = { ...before, phase: 'query_failed', error: 'PRIVATE', queryReason: 'NETWORK_FAILURE' };
  await logCollectorTransition('chzzk', before, failed);
  await logCollectorTransition('chzzk', failed, failed);
  await logCollectorTransition('chzzk', failed, { ...before, error: null });
  const events = await getCollectorEvents();
  assert.deepEqual(events.map(event => event.type), ['query_failed', 'query_recovered', 'playing']);
  assert.equal(events[0].reason, 'NETWORK_FAILURE');
});
