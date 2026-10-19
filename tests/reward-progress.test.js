import test from 'node:test';
import assert from 'node:assert/strict';
import { rewardProgress, progressMinutes, progressLabel, collectionProgressRows } from '../src/services/reward-progress.js';
import { campaignProgress } from '../src/services/collector-plans.js';
import { summarizeTwitchCampaign } from '../src/services/twitch-collector-plan.js';

const progress = extra => rewardProgress({ id: 1, name: '토큰', current: 45, required: 60, ...extra });
const now = Date.parse('2026-10-19T07:30:00+09:00');
const settings = { autoCollectChzzk: true, autoCollectTwitch: false, chzzkCollectCampaign: 'auto' };
const campaign = extra => ({ id: '1', title: '테스트 캠페인', active: true, progressCheckedAt: now,
  rewards: [progress({})], ...extra });
const rows = (extra = {}, config = settings, at = now) => collectionProgressRows({ chzzk: { campaignsCheckedAt: now,
  campaigns: [campaign({})], ...extra } }, config, at);
test('progress uses the server minutes and the individual threshold', () => {
  assert.equal(progress({}).percent, 75); assert.equal(progressLabel(progress({})), '45/60분');
});
test('only explicit zero is shown as zero progress', () => {
  assert.equal(progress({ current: '0' }).percent, 0);
  for (const current of [null, undefined, '', ' ', false, -1, NaN, Infinity, 'invalid']) {
    assert.equal(progress({ current }).percent, null); assert.equal(progress({ current }).state, 'unknown');
  }
});
test('missing or non-positive requirements are unknown rather than dividing by one', () => {
  for (const required of [null, undefined, '', 0, -1, false, Infinity]) assert.equal(progress({ required }).percent, null);
});
test('percent never rounds an unfinished reward up to 100', () => {
  assert.equal(progress({ current: 59.99 }).percent, 99);
  assert.equal(progress({ current: 60 }).percent, 100); assert.equal(progress({ current: 120 }).percent, 100);
});
test('confirmed receipts, earned rewards and threshold completion remain distinct', () => {
  assert.equal(progressLabel(progress({ claimed: true, current: null })), '수령 완료');
  assert.equal(progressLabel(progress({ earned: true, current: null })), '수령 대기');
  assert.equal(progressLabel(progress({ current: 60 })), '시청 조건 달성');
  assert.equal(progress({ claimed: true, current: null, required: null }).percent, 100);
});
test('exhausted stock is labelled even if watch time reaches the threshold', () => {
  assert.equal(progressLabel(progress({ current: 60, exhausted: true })), '보상 소진');
  assert.equal(progressLabel(progress({ earned: true, exhausted: true })), '수령 대기');
});
test('numeric strings are supported without accepting malformed watch durations', () => {
  assert.equal(progressMinutes('45'), 45); assert.equal(progressMinutes({}), null);
});
test('CHZZK progress matches rewards by ID without reusing the campaign maximum', () => {
  const result = campaignProgress({ rewardList: [
    { rewardNo: 1, rewardName: '첫 토큰', conditionForMinutes: 60 },
    { rewardNo: 2, conditionForMinutes: 90 }, { rewardNo: 3, conditionForMinutes: 120 }
  ] }, [], [{ rewardNo: 1, accumWatchMinutes: 45 }, { rewardNo: 2, accumWatchMinutes: 20 }]);
  assert.deepEqual(result.rewards.map(r => r.percent), [75, 22, null]);
  assert.equal(result.rewards[0].name, '첫 토큰'); assert.equal(result.rewards[2].name, '보상 3');
});
test('CHZZK claims distinguish an earned coupon from one already issued', () => {
  const result = campaignProgress({ rewardList: [{ rewardNo: 1 }, { rewardNo: 2 }, { rewardNo: 3 }] },
    [{ rewardNo: 1, fulfillmentState: 'COMPLIED' }, { rewardNo: 2, fulfillmentState: 'REQUESTED' }, { rewardNo: 3, code: 'FIXTURE' }], []);
  assert.deepEqual(result.rewards.map(r => r.state), ['earned', 'claimed', 'claimed']);
  assert.ok(result.rewards.every(r => r.percent === 100));
  assert.equal(JSON.stringify(result.rewards).includes('FIXTURE'), false);
});
test('a full CHZZK timer is display-only and does not change collection completion', () => {
  const result = campaignProgress({ rewardList: [{ rewardNo: 1, conditionForMinutes: 60 }] }, [], [{ rewardNo: 1, accumWatchMinutes: 60 }]);
  assert.equal(result.rewards[0].percent, 100); assert.equal(result.completed, false);
});
test('Twitch progress uses each tier, with fresh inventory and claimed state', () => {
  const result = summarizeTwitchCampaign({ id: '1', timeBasedDrops: [
    { id: 'a', name: '토큰', requiredMinutesWatched: 60, self: { currentMinutesWatched: 10 } },
    { id: 'b', requiredMinutesWatched: 90, self: { currentMinutesWatched: 45 } },
    { id: 'c', requiredMinutesWatched: 120, self: { isClaimed: true } }
  ] }, { timeBasedDrops: [{ id: 'a', self: { currentMinutesWatched: 45 } }] });
  assert.deepEqual(result.rewards.map(r => r.percent), [75, 50, 100]);
  assert.equal(result.rewards[2].state, 'claimed');
});
test('Twitch missing self or watch time stays unknown for display', () => {
  const result = summarizeTwitchCampaign({ id: '1', timeBasedDrops: [{ id: 'a', requiredMinutesWatched: 60 }] }, null);
  assert.equal(result.rewards[0].percent, null); assert.equal(result.rewards[0].currentMinutes, null);
});
test('Twitch pending tiers are 100 while an unfinished tier can keep collecting', () => {
  const result = summarizeTwitchCampaign({ id: '1', timeBasedDrops: [
    { id: 'a', requiredMinutesWatched: 60, self: { currentMinutesWatched: 60 } },
    { id: 'b', requiredMinutesWatched: 90, self: { currentMinutesWatched: 45 } }
  ] }, null);
  assert.equal(result.rewards[0].state, 'earned'); assert.equal(result.watchable, true); assert.equal(result.completed, false);
});
test('disabled automatic collectors add no progress panel', () => {
  assert.deepEqual(collectionProgressRows({}, {}), []); assert.equal(rows().length, 1);
});
test('the summary shows the next reward rather than summing simultaneous tiers', () => {
  const [row] = rows({ campaigns: [campaign({ rewards: [progress({ claimed: true }), progress({ id: 2 }), progress({ id: 3, required: 90 })] })] });
  assert.equal(row.percent, 75); assert.equal(row.earned, 1); assert.equal(row.total, 3); assert.equal(row.next.id, '2');
});
test('the currently watched unfinished campaign has priority', () => {
  const [row] = rows({ campaignId: '2', campaigns: [campaign({}), campaign({ id: '2', title: '두 번째', rewards: [progress({ current: 30 })] })] });
  assert.equal(row.title, '두 번째'); assert.equal(row.percent, 50);
});
test('an unknown next reward is not silently replaced by a later tier with known progress', () => {
  const [row] = rows({ campaigns: [campaign({ rewards: [progress({ current: null }), progress({ id: 2, required: 90 })] })] });
  assert.equal(row.percent, null); assert.equal(row.next.id, '1'); assert.equal(row.label, '확인 대기');
});
test('a completed current campaign yields the next unfinished campaign', () => {
  const [row] = rows({ campaignId: '1', campaigns: [campaign({ rewards: [progress({ claimed: true })] }), campaign({ id: '2' })] });
  assert.equal(row.next.state, 'watching'); assert.equal(row.percent, 75);
});
test('all earned rewards show 100 but do not imply all have been claimed', () => {
  const [row] = rows({ campaigns: [campaign({ rewards: [progress({ earned: true })] })] });
  assert.equal(row.percent, 100); assert.equal(row.label, '시청 조건 달성');
  assert.equal(rows({ campaigns: [campaign({ rewards: [progress({ claimed: true })] })] })[0].label, '수령 완료');
});
test('a query error preserves the previous percent and marks it stale', () => {
  const [row] = rows({ error: 'offline', phase: 'query_failed' });
  assert.equal(row.percent, 75); assert.equal(row.stale, true); assert.equal(row.status, '조회 실패');
});
test('snapshots age without a new worker write', () => {
  assert.equal(rows({}, settings, now + 179999)[0].stale, false);
  assert.equal(rows({}, settings, now + 180000)[0].stale, true);
});
test('the 05:00 boundary marks an earlier snapshot as previous even if only seconds old', () => {
  const reset = Date.parse('2026-10-19T05:00:00+09:00');
  const [row] = rows({ campaigns: [campaign({ progressCheckedAt: reset - 1000 })] }, settings, reset);
  assert.equal(row.stale, true);
});
test('future or absent timestamps cannot be presented as current progress', () => {
  assert.equal(rows({ campaigns: [campaign({ progressCheckedAt: now + 1 })] })[0].stale, true);
  assert.equal(rows({ campaigns: [campaign({ progressCheckedAt: undefined })], campaignsCheckedAt: undefined })[0].stale, true);
});
test('fixed CHZZK selection never shows another campaign as its progress', () => {
  const [row] = rows({ campaigns: [campaign({})] }, { ...settings, chzzkCollectCampaign: '2' });
  assert.equal(row.percent, null); assert.deepEqual(row.campaigns, []);
});
test('partial campaign failures keep the old reward snapshot marked as previous', () => {
  const [row] = rows({ progressCampaigns: [campaign({ progressStale: true })], catalogRetrying: true });
  assert.equal(row.percent, 75); assert.equal(row.stale, true); assert.equal(row.partial, true);
});
test('legacy snapshots wait for per-reward data instead of treating aggregate minutes as percent', () => {
  const [row] = rows({ campaigns: [campaign({ rewards: undefined, minutes: 45 })] });
  assert.equal(row.percent, null); assert.equal(row.label, '확인 대기');
});
test('manually paused collection can display freshly fetched server progress', () => {
  const [row] = rows({ userStopped: true }); assert.equal(row.status, '일시 중지'); assert.equal(row.stale, false); assert.equal(row.percent, 75);
});
