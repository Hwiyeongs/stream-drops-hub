import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isEternalReturnGame, summarizeTwitchCampaign, twitchPlan } from '../src/services/twitch-collector-plan.js';
import { clearCapturedTwitchGqlHeaders } from '../src/services/twitch-headers.js';

let pages, requested, tabActions, capture, awardedRejected, localData;
const campaign = (id = 'er-1') => ({ id, name: 'Eternal Return Drops', status: 'ACTIVE',
  startAt: '2020-01-01T00:00:00Z', endAt: '2099-01-01T00:00:00Z',
  game: { id: 'game-1', slug: 'eternal-return', displayName: 'Eternal Return' } });
const detail = () => ({ ...campaign(), allow: { channels: [] },
  timeBasedDrops: [{ id: 'reward-1', requiredMinutesWatched: 60, self: { currentMinutesWatched: 10, isClaimed: false } }] });

beforeEach(() => {
  requested = []; tabActions = []; awardedRejected = false; localData = {};
  capture = { at: Date.now(), headers: { Authorization: 'OAuth test', 'Client-Integrity': 'test' } };
  pages = {
    HubDropsViewer: { currentUser: { id: 'user-1', login: 'viewer' } },
    HubDropsCampaigns: { currentUser: { dropCampaigns: [campaign(), { ...campaign('other'), game: { displayName: 'Other Game' } }] } },
    HubDropsInventory: { currentUser: { inventory: { dropCampaignsInProgress: [{ id: 'er-1', timeBasedDrops: [
      { id: 'reward-1', self: { currentMinutesWatched: 15, isClaimed: false } },
    ] }] } } },
    Inventory: { currentUser: { inventory: { gameEventDrops: [] } } },
    HubDropsDetails: { user: { dropCampaign: detail() } },
    HubDropsGameLives: { game: { id: 'game-1', streams: { edges: [
      { node: { id: 'stream-1', viewersCount: 42, broadcaster: { login: 'er_streamer' } } },
    ] } } },
    HubDropsAllowedLives: { users: [] },
  };
  globalThis.chrome = {
    cookies: { async get() { return { value: 'test' }; }, async getAll() { return []; } },
    storage: { session: { async get() { return { twitchGqlHeaders: capture }; }, async remove() { capture = null; } },
      local: { async get(key) { return key == null ? structuredClone(localData) : { [key]: localData[key] }; },
        async set(value) { Object.assign(localData, structuredClone(value)); } } },
    tabs: { async create(options) { tabActions.push(['create', options]); return { id: 7, ...options }; },
      async update(id, options) { tabActions.push(['update', id, options]); },
      async get() { return { id: 7, url: 'https://www.twitch.tv/drops/inventory' }; },
      async remove(id) { tabActions.push(['remove', id]); } },
  };
  globalThis.fetch = async (_url, options) => {
    const { operationName, variables, query } = JSON.parse(options.body);
    requested.push({ operationName, variables, query });
    if (operationName === 'Inventory') return new Response(JSON.stringify({ data: {
      currentUser: { id: pages.HubDropsViewer.currentUser.id, ...pages.HubDropsInventory.currentUser },
    } }));
    if (operationName === 'Inventory' && awardedRejected)
      return new Response(JSON.stringify({ errors: [{ message: 'PersistedQueryNotFound' }] }));
    return new Response(JSON.stringify({ data: pages[operationName] }));
  };
});

test('Twitch plan chooses an Eternal Return Drops-enabled live and uses server progress', async () => {
  const plan = await twitchPlan();
  assert.equal(plan.campaigns.length, 1);
  assert.equal(plan.campaigns[0].minutes, 15);
  assert.equal(plan.candidates[0].lives[0].url, 'https://www.twitch.tv/er_streamer');
  assert.equal(requested.filter(r => r.operationName === 'HubDropsDetails').length, 1);
  assert.equal(requested.filter(r => r.operationName === 'Inventory').length, 1);
  assert.equal(requested.some(r => r.operationName === 'HubDropsInventory'), false);
  assert.equal(tabActions.length, 0);
});

test('restricted campaign uses only live allowlisted channels in the right game', async () => {
  pages.HubDropsDetails.user.dropCampaign.allow.channels = [{ name: 'right' }, { name: 'wrong_game' }];
  pages.HubDropsAllowedLives.users = [
    { login: 'right', stream: { id: 'live-1', viewersCount: 1, game: { id: 'game-1' } } },
    { login: 'wrong_game', stream: { id: 'live-2', viewersCount: 100, game: { id: 'other-game' } } },
  ];
  const plan = await twitchPlan();
  assert.deepEqual(plan.candidates[0].lives.map(l => l.channelId), ['right']);
  assert.equal(requested.some(r => r.operationName === 'HubDropsGameLives'), false);
});

test('a restricted campaign with no channel list does not fall back to unrelated game streams', async () => {
  pages.HubDropsDetails.user.dropCampaign.allow = { isEnabled: true, channels: [] };
  const plan = await twitchPlan();
  assert.equal(plan.candidates[0].lives.length, 0);
  assert.equal(requested.some(r => r.operationName === 'HubDropsGameLives'), false);
});

test('keeps a live current channel when it falls outside the first thirty category results', async () => {
  pages.HubDropsAllowedLives.users = [{ login: 'current', stream: { id: 'current-live', viewersCount: 1,
    game: { id: 'game-1' } } }];
  const plan = await twitchPlan(Date.now(), 'current');
  assert.equal(plan.candidates[0].lives.some(l => l.channelId === 'current'), true);
  assert.deepEqual(requested.find(r => r.operationName === 'HubDropsAllowedLives').variables.logins, ['current']);
});

test('an unlinked game account still earns watch time; linking is advisory', async () => {
  pages.HubDropsDetails.user.dropCampaign.self = { isAccountConnected: false };
  const plan = await twitchPlan();
  assert.equal(plan.needsLink, true);
  assert.equal(plan.candidates.length, 1);
});

test('opens only a temporary official inventory tab to acquire Twitch page headers', async () => {
  await clearCapturedTwitchGqlHeaders();
  const create = chrome.tabs.create;
  chrome.tabs.create = async options => {
    assert.equal(options.url, 'https://www.twitch.tv/drops/inventory');
    capture = { at: Date.now(), headers: { Authorization: 'OAuth test', 'Client-Integrity': 'test' } };
    return create(options);
  };
  try {
    const plan = await twitchPlan();
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(tabActions.map(a => a[0]), ['create', 'update', 'remove']);
  } finally { chrome.tabs.create = create; }
});

test('claimable tier waits for claim instead of reporting watch completion', async () => {
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress[0].timeBasedDrops[0].self.currentMinutesWatched = 60;
  const plan = await twitchPlan();
  assert.equal(plan.needsClaim, true);
  assert.equal(plan.finished, false);
  assert.equal(plan.candidates.length, 0);
  assert.equal(summarizeTwitchCampaign(detail(), null).completed, false);
});

test('a recent aggregate benefit award does not prove the campaign tier was claimed', async () => {
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress = [];
  pages.Inventory.currentUser.inventory.gameEventDrops = [{ id: 'benefit-1', lastAwardedAt: '2026-09-30T00:00:00Z' }];
  const tier = pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0];
  tier.self = { isClaimed: false, currentMinutesWatched: 0 };
  tier.benefitEdges = [{ benefit: { id: 'benefit-1' } }];
  const plan = await twitchPlan();
  assert.equal(plan.campaigns[0].earned, 0);
  assert.equal(plan.campaigns[0].completed, false);
  assert.equal(plan.campaigns[0].verificationPending, undefined);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.finished, false);
  assert.equal(requested.filter(r => r.operationName === 'Inventory').length, 1);
});

test('a campaign without a tier requiring watch time cannot open a stream', async () => {
  const tier = pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0];
  tier.requiredMinutesWatched = 0;
  tier.self = { isClaimed: false, currentMinutesWatched: 0 };
  const plan = await twitchPlan();
  assert.equal(plan.campaigns[0].canWatch, false);
  assert.equal(plan.candidates.length, 0);
});

test('unavailable aggregate award history cannot block a new zero-progress campaign', async () => {
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress = [];
  const tier = pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0];
  tier.self = null;
  tier.benefitEdges = [{ benefit: { id: 'benefit-1' } }];
  awardedRejected = true;
  const plan = await twitchPlan();
  assert.equal(plan.campaigns[0].earned, 0);
  assert.equal(plan.campaigns[0].completed, false);
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.needsVerification, undefined);
  assert.equal(requested.filter(r => r.operationName === 'Inventory').length, 1);
});

test('a new unclaimed campaign can still start when the award inventory is available and empty', async () => {
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress = [];
  const tier = pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0];
  tier.self = { isClaimed: false, currentMinutesWatched: 0 };
  tier.benefitEdges = [{ benefit: { id: 'new-benefit' } }];
  const plan = await twitchPlan();
  assert.equal(plan.needsVerification, undefined);
  assert.equal(plan.candidates.length, 1);
});

test('one aggregate award cannot prove multiple tiers sharing the same benefit', async () => {
  const tier = pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0];
  tier.self = { isClaimed: false, currentMinutesWatched: 0 };
  tier.benefitEdges = [{ benefit: { id: 'shared-token' } }];
  pages.HubDropsDetails.user.dropCampaign.timeBasedDrops.push({ ...tier, id: 'reward-2' });
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress = [];
  pages.Inventory.currentUser.inventory.gameEventDrops = [{ id: 'shared-token', lastAwardedAt: '2026-09-30T00:00:00Z' }];
  const plan = await twitchPlan();
  assert.equal(plan.campaigns[0].earned, 0);
  assert.equal(plan.campaigns[0].verificationPending, undefined);
  assert.equal(plan.candidates.length, 1);
});

test('repeated tokens in a fresh campaign start automatically', async () => {
  const tier = pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0];
  tier.self = { isClaimed: false, currentMinutesWatched: 0 };
  tier.benefitEdges = [{ benefit: { id: 'shared-token' } }];
  pages.HubDropsDetails.user.dropCampaign.timeBasedDrops.push({ ...tier, id: 'reward-2' });
  const plan = await twitchPlan();
  assert.equal(plan.needsVerification, undefined);
  assert.equal(plan.candidates.length, 1);
});

test('awarded benefit from a different date cannot complete a current Twitch tier', async () => {
  const tier = detail().timeBasedDrops[0];
  tier.self = null;
  tier.benefitEdges = [{ benefit: { id: 'benefit-1' } }];
  tier.startAt = '2026-09-29T00:00:00Z';tier.endAt = '2026-09-30T00:00:00Z';
  const result = summarizeTwitchCampaign({ ...detail(), timeBasedDrops: [tier] }, null, Date.now(),
    [{ id: 'benefit-1', lastAwardedAt: '2026-09-30T00:00:01Z' }]);
  assert.equal(result.completed, false);
});

test('missing campaign or inventory field is an error, not an empty completed plan', async () => {
  delete pages.HubDropsCampaigns.currentUser.dropCampaigns;
  await assert.rejects(twitchPlan(), /캠페인 목록 형식/);
  pages.HubDropsCampaigns.currentUser.dropCampaigns = [campaign()];
  delete pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress;
  await assert.rejects(twitchPlan(), /보관함 목록/);
});

test('Twitch plan rejects malformed broadcast addresses and unrelated categories', () => {
  assert.equal(isEternalReturnGame({ displayName: 'Eternal Return' }), true);
  assert.equal(isEternalReturnGame({ displayName: '이터널 리턴' }), true);
  assert.equal(isEternalReturnGame({ displayName: 'Other Game' }), false);
});

test('claimed flags from either campaign or inventory stop viewing without a manual choice',async()=>{
 pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0].self.isClaimed=true;
 assert.equal((await twitchPlan()).finished,true);
 pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0].self.isClaimed=false;
 pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress[0].timeBasedDrops[0].self.isClaimed=true;
 const plan=await twitchPlan();assert.equal(plan.finished,true);assert.equal(plan.candidates.length,0);
});

const receipt = (extra = {}) => ({ id: 'twitch_instance-1', platform: 'twitch', actionType: 'claimed',
  twitchUserId: 'user-1', campaignId: 'er-1', timeBasedDropId: 'reward-1', dropInstanceId: 'instance-1',
  claimedAt: Date.now(), ...extra });

test('a confirmed local receipt completes an empty server tier without opening another live', async () => {
  localData['handled:twitch_instance-1'] = receipt();
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress = [];
  pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0].self = null;
  const plan = await twitchPlan();
  assert.equal(plan.finished, true); assert.equal(plan.campaigns[0].earned, 1);
  assert.equal(plan.campaigns[0].minutes, 0);
  assert.equal(plan.claimedToday, 1); assert.equal(plan.candidates.length, 0);
  assert.equal(requested.some(r => r.operationName === 'HubDropsGameLives'), false);
});

test('same reward name, different campaign, account or tier cannot reuse a local receipt', async () => {
  for (const extra of [{ campaignId: 'old-campaign' }, { twitchUserId: 'other-user' },
    { timeBasedDropId: 'other-tier' }, { platform: 'chzzk' }, { actionType: 'saved' },
    { twitchUserId: null }, { campaignId: null }, { timeBasedDropId: null }]) {
    localData['handled:twitch_instance-1'] = receipt(extra);
    const plan = await twitchPlan();
    assert.equal(plan.campaigns[0].earned, 0, JSON.stringify(extra));
    assert.equal(plan.candidates.length, 1); assert.equal(plan.campaigns[0].claimedToday, 0);
  }
});

test('today receipts remain visible after the campaign disappears and duplicate instance records count once', async () => {
  localData['handled:twitch_instance-1'] = receipt();
  localData['handled:duplicate'] = receipt();
  pages.HubDropsCampaigns.currentUser.dropCampaigns = [];
  const plan = await twitchPlan();
  assert.equal(plan.campaigns.length, 0); assert.equal(plan.claimedToday, 1);
  pages.HubDropsViewer.currentUser.id = 'other-account';
  assert.equal((await twitchPlan()).claimedToday, 0);
});

test('a receipt for a different instance does not complete the current instance', async () => {
  localData['handled:twitch_instance-1'] = receipt();
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress[0].timeBasedDrops[0].self.dropInstanceID = 'instance-2';
  assert.equal((await twitchPlan()).finished, false);
});

test('only the exact claimed tier is completed when three tiers share a token', async () => {
  const base = pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0];
  base.self = { isClaimed: false, currentMinutesWatched: 60 };
  base.benefitEdges = [{ benefit: { id: 'same-token' } }];
  pages.HubDropsDetails.user.dropCampaign.timeBasedDrops.push(
    { ...base, id: 'reward-2', self: { isClaimed: false, currentMinutesWatched: 0 } },
    { ...base, id: 'reward-3', self: { isClaimed: false, currentMinutesWatched: 0 } });
  localData['handled:twitch_instance-1'] = receipt();
  const plan = await twitchPlan();
  assert.equal(plan.finished, false); assert.equal(plan.campaigns[0].earned, 1);
  assert.equal(plan.campaigns[0].total, 3); assert.equal(plan.claimedToday, 1);
  assert.equal(plan.needsClaim, false); assert.equal(plan.candidates.length, 1);
});

test('05:00 KST resets today count while preserving completion of a one-time campaign', () => {
  const claimedAt = Date.parse('2026-09-30T04:59:00+09:00');
  const context = { twitchUserId: 'user-1', handled: { entry: receipt({ claimedAt }) } };
  const before = summarizeTwitchCampaign(detail(), null, claimedAt, context);
  const after = summarizeTwitchCampaign(detail(), null, Date.parse('2026-09-30T05:00:00+09:00'), context);
  assert.equal(before.claimedToday, 1); assert.equal(after.claimedToday, 0);
  assert.equal(after.completed, true); assert.equal(after.watchable, false);
});

test('already-claimed or unknown original dates prove completion without claiming today', () => {
  const now = Date.parse('2026-09-30T10:00:00+09:00');
  for (const claimedAt of [null, undefined, 'today', now + 1000]) {
    const result = summarizeTwitchCampaign(detail(), null, now,
      { twitchUserId: 'user-1', handled: { entry: receipt({ claimedAt }) } });
    assert.equal(result.completed, true); assert.equal(result.claimedToday, 0);
  }
});

test('legacy receipt is linked only by the server exact instance and all original dates remain unchanged', async () => {
  const receivedAt = Date.now() - 5000;
  const old = { id: 'twitch_old-instance', platform: 'twitch', actionType: 'claimed',
    rewardName: 'Emoticon englishnoob', receivedAt, handledAt: receivedAt + 1 };
  localData['handled:twitch_old-instance'] = structuredClone(old);
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress[0].timeBasedDrops[0].self.dropInstanceID = 'old-instance';
  const plan = await twitchPlan();
  const linked = localData['handled:twitch_old-instance'];
  assert.equal(plan.finished, true); assert.equal(plan.claimedToday, 1);
  assert.equal(linked.twitchUserId, 'user-1'); assert.equal(linked.campaignId, 'er-1');
  assert.equal(linked.timeBasedDropId, 'reward-1'); assert.equal(linked.dropInstanceId, 'old-instance');
  assert.equal(linked.receivedAt, old.receivedAt); assert.equal(linked.handledAt, old.handledAt);
  assert.equal(linked.claimedAt, undefined); assert.equal(linked.rewardName, old.rewardName);
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress = [];
  pages.HubDropsDetails.user.dropCampaign.timeBasedDrops[0].self = null;
  assert.equal((await twitchPlan()).finished, true);
});

test('legacy receipts with a different instance or known different account cannot be linked by name', async () => {
  for (const extra of [{}, { twitchUserId: 'other-account', dropInstanceId: 'official-instance' }]) {
    const old = { id: 'twitch_old-instance', platform: 'twitch', actionType: 'claimed',
      rewardName: 'Drops Token', receivedAt: Date.now(), ...extra };
    localData['handled:twitch_old-instance'] = structuredClone(old);
    pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress[0].timeBasedDrops[0].self.dropInstanceID = 'official-instance';
    const plan = await twitchPlan();
    assert.equal(plan.finished, false); assert.equal(plan.claimedToday, 0);
    assert.deepEqual(localData['handled:twitch_old-instance'], old);
  }
});

test('three claimable tokens count as achieved and pending, without pretending they were claimed', async () => {
  const drops = [1, 2, 3].map(i => ({ id: 'reward-' + i, requiredMinutesWatched: 60,
    self: { isClaimed: false, currentMinutesWatched: 60, dropInstanceID: 'instance-' + i } }));
  pages.HubDropsDetails.user.dropCampaign.timeBasedDrops = drops.map(d => ({ ...d, self: null }));
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress[0].timeBasedDrops = drops;
  const plan = await twitchPlan(); const c = plan.campaigns[0];
  assert.equal(c.earned, 3); assert.equal(c.total, 3); assert.equal(c.claimed, 0); assert.equal(c.pending, 3);
  assert.equal(c.completed, false); assert.equal(plan.needsClaim, true); assert.equal(plan.candidates.length, 0);
  assert.equal(plan.claimedToday, 0);
});

test('the popup inventory and collection plan use the same confirmed claimed flags', async () => {
  pages.HubDropsInventory.currentUser.inventory.dropCampaignsInProgress[0].timeBasedDrops[0].self.isClaimed = true;
  const plan = await twitchPlan();
  assert.equal(plan.campaigns[0].claimed, 1); assert.equal(plan.campaigns[0].earned, 1);
  assert.equal(plan.finished, true); assert.equal(plan.candidates.length, 0);
});

test('different inventory and captured-header accounts cause an error instead of false zero progress', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (JSON.parse(options.body).operationName !== 'Inventory') return originalFetch(url, options);
    return new Response(JSON.stringify({ data: { currentUser: { id: 'other-user',
      inventory: { dropCampaignsInProgress: [] } } } }));
  };
  await assert.rejects(twitchPlan(), /로그인 계정이 다릅니다/);
  assert.equal(capture, null);
});
