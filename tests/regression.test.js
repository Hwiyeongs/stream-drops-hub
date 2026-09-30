import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const APP_VERSION = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url))).version;
let data = {}, sessionData = {}, alarms = new Map(), notifications = [], mutations = [], mode = 'success';
let campaigns = [], soopAvailable = [], soopAcquired = [], chzzkClaims = [], soopHtml = false;
const listeners = {};
const event = name => ({ addListener(fn) { listeners[name] = fn; } });
globalThis.chrome = {
  runtime: { id: 'test', getManifest: () => ({ version: APP_VERSION }), getURL: p => 'chrome-extension://test/' + p, onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
  storage: {
    local: {
      async get(keys) { if (keys == null) return structuredClone(data); if (typeof keys === 'string') keys = [keys]; return Object.fromEntries(keys.filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
      async set(obj) { Object.assign(data, structuredClone(obj)); },
      async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key]; },
    },
    session: {
      async get(keys) { if (keys == null) return structuredClone(sessionData); if (typeof keys === 'string') keys = [keys]; return Object.fromEntries(keys.filter(k => k in sessionData).map(k => [k, structuredClone(sessionData[k])])); },
      async set(obj) { Object.assign(sessionData, structuredClone(obj)); },
      async remove(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) delete sessionData[key]; },
    },
  },
  alarms: { async get(name) { return alarms.get(name); }, async create(name, value) { alarms.set(name, value); }, async clear(name) { return alarms.delete(name); }, onAlarm: event('alarm') },
  notifications: { onClicked: event('notificationClicked'), async create(id, entry) { notifications.push({ id, ...entry }); return id; } },
  cookies: { async get({ name }) { return name === 'auth-token' ? { value: 'mock-token' } : null; }, async getAll() { return []; } },
  tabs: { async query() { return []; } },
  scripting: { async executeScript() { throw new Error('Unexpected script'); } },
  webRequest: { onSendHeaders: event('webRequestSendHeaders') },
};
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const mockFetch = async (url, options = {}) => {
  if (url.endsWith('/integrity')) return json({});
  if (url.endsWith('/gql')) {
    const body = JSON.parse(options.body);
    if (body.operationName === 'Inventory') return json({ data: { currentUser: { id: 'user-1', login: 'viewer', inventory: { dropCampaignsInProgress: campaigns } } } });
    if (body.operationName === 'HubDropsClaimViewer') return json({ data: { currentUser: { id: 'user-1', login: 'viewer' } } });
    mutations.push(body.variables.input.dropInstanceID);
    if (mode === 'error') return json({ errors: [{ message: 'Temporary failure' }] });
    return json({ data: { claimDropRewards: { status: mode === 'unknown' ? 'NOT_ELIGIBLE' : mode === 'already-claimed' ? 'DROP_INSTANCE_ALREADY_CLAIMED' : 'SUCCESS' } } });
  }
  if (url.endsWith('/drops/rewards/claims')) return json({ code: 200, content: { claimList: chzzkClaims } });
  if (url.includes('/coupon-code')) return json({ content: { code: mode === 'coupon-missing' ? null : 'TEST-CODE' } });
  if (url.endsWith('/claim')) return json({ code: 200 });
  if (url.endsWith('get_drops_use_info.php')) return json({ data: mode === 'coupon-missing' ? {} : { itemCode: 'SOOP-CODE' } });
  if (url.endsWith('get_drops_list.php')) {
    if (soopHtml) return new Response('<html>Login</html>');
    return json({ data: JSON.parse(options.body).division === 'available' ? soopAvailable : soopAcquired });
  }
  throw new Error('Unexpected network URL: ' + url);
};
globalThis.fetch = mockFetch;
const storage = await import('../src/services/storage.js');
const { fetchAllDrops, claimUnifiedDrop, isActiveDrop } = await import('../src/services/aggregator.js');
const { fetchTwitchDrops, claimTwitchDrop, decodeInventoryResponse } = await import('../src/services/twitch.js');
const twitchHeaders = await import('../src/services/twitch-headers.js');
const { fetchSoopDrops, claimSoopDrop, parseItemDateValue } = await import('../src/services/soop.js');
const { fetchChzzkDrops } = await import('../src/services/chzzk.js');
const { fetchWithTimeout } = await import('../src/services/fetch-helper.js');
const worker = await import('../background/service-worker.js');
await worker.enqueue(async () => {});
beforeEach(async () => {
  data = { appVersion: APP_VERSION, itemStorageMigrated: true };
  sessionData = {};
  await twitchHeaders.clearCapturedTwitchGqlHeaders();
  sessionData = { twitchGqlHeaders: { headers: { Authorization: 'OAuth mock-token', 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Client-Integrity': 'mock-integrity', 'Client-Session-Id': 'mock-session', 'Client-Version': 'mock-version', 'Device-ID': 'mock-device' }, at: Date.now(), tabId: 12 } };
  alarms = new Map(); notifications = []; mutations = []; mode = 'success';
  campaigns = []; soopAvailable = []; soopAcquired = []; chzzkClaims = []; soopHtml = false;
  globalThis.fetch = mockFetch;
  chrome.tabs.query = async () => [];
});
function campaign() { return { id: 'campaign', name: 'Campaign', endAt: '2099-01-01T00:00:00Z', timeBasedDrops: [{ id: 'reward', name: 'Reward', requiredMinutesWatched: 60, self: { currentMinutesWatched: 60, isClaimed: false, dropInstanceID: 'instance-B' } }] }; }
function coupon(id = 'c1') { return { id, platform: 'chzzk', platformName: '치지직', rewardNo: 1, isCoupon: true, claimable: true, rewardName: '쿠폰', expDate: '2099-01-01' }; }

test('migration deletes actual old cache and preserves coupon history', async () => {
  data = { appVersion: '1.2.4', dropsCache: [{ id: 'old' }], cachedDrops: [], lastUpdated: 123, handledDropsLog: { old: { id: 'old', couponCode: 'C' } }, savedCouponCodes: { 1: 'S' } };
  await storage.initializeStorage();
  assert.equal(data.dropsCache, undefined); assert.equal(data.lastUpdated, undefined);
  assert.equal(data['handled:old'].couponCode, 'C'); assert.equal(data['coupon:1'], 'S');
  assert.equal(data.appVersion, APP_VERSION);
});
test('concurrent writes preserve every independent record and coupon', async () => {
  await Promise.all(Array.from({ length: 30 }, (_, i) => storage.recordHandledDrop(coupon('c' + i), 'saved')));
  await Promise.all(Array.from({ length: 30 }, (_, i) => storage.saveCouponCode(i, 'CODE' + i)));
  assert.equal(Object.keys(await storage.getHandledDropsLog()).length, 30);
  assert.equal(Object.keys(await storage.getSavedCouponCodes()).length, 30);
});
test('expiry is KST end-of-day and achievement window is calendar based', () => {
  const now = Date.parse('2026-09-08T12:00:00+09:00');
  assert.equal(storage.parseExpTimestamp('2026.09.08'), Date.parse('2026-09-08T23:59:59.999+09:00'));
  assert.equal(storage.isRecentDate('2026-09-07', now), true);
  assert.equal(storage.isRecentDate('2026-09-06T23:59:59+09:00', now), false);
  assert.equal(storage.parseExpTimestamp('2026-02-30'), null);
  assert.equal(storage.parseTimestamp('2026-09-08 24:00'), null);
});
test('SOOP yearless December date resolves to previous year around New Year', () => {
  assert.equal(parseItemDateValue({ itemName: '[12/31]' }, Date.parse('2027-01-01T10:00:00+09:00')), Date.parse('2026-12-31T00:00:00+09:00'));
});
test('expired rewards stay in history and do not return to the claimable list', async () => {
  const old = { ...coupon('old'), platform: 'soop', itemCodeIdx: 42, expDate: '2020-01-01',
    couponCode: 'OLD-CODE', receivedAt: Date.parse('2020-01-01T10:00:00+09:00') };
  data['handled:old'] = { ...old, actionType: 'copied' };
  data['coupon:42'] = 'OLD-CODE';
  await worker.initialize();
  assert.equal((await storage.getHandledDropsLog()).old.couponCode, 'OLD-CODE');
  assert.equal(data['coupon:42'], 'OLD-CODE');
  assert.equal(isActiveDrop(old, await storage.getHandledDropsLog()), false);
});
test('SOOP bracketed reward date takes priority over an event date range', () => {
  const text = '2026-09-01 ~ 2026-09-30 이벤트 [09/27] 보상';
  assert.equal(parseItemDateValue({ itemName: text, sendDate: '2026-09-29' }), Date.parse('2026-09-27T00:00:00+09:00'));
  assert.equal(parseItemDateValue({ itemName: '2026-09-01 이벤트 [2026-09-27] 보상' }), Date.parse('2026-09-27T00:00:00+09:00'));
});
test('SOOP rejects HTML login response instead of reporting empty success', async () => {
  soopHtml = true;
  const result = await fetchSoopDrops();
  assert.ok(result.error); assert.notEqual(result.loggedIn, true);
});
test('SOOP excludes old latest rounds, retaining today and yesterday only', async () => {
  const old = new Date(storage.yesterdayStart() - 86400000).toISOString();
  soopAcquired = [{ itemCodeIdx: 1, itemName: 'old', sendDate: old, expDate: '2099-01-01' }, { itemCodeIdx: 2, itemName: 'current', sendDate: new Date().toISOString(), expDate: '2099-01-01' }];
  assert.deepEqual((await fetchSoopDrops()).drops.map(d => d.itemCodeIdx), [2]);
});
test('CHZZK avoids serial coupon fetches and preserves an issued valid coupon after claim deadline', async () => {
  chzzkClaims = [{ rewardNo: 1, rewardType: 'CODE', fulfillmentState: 'COMPLETED', createdDate: new Date().toISOString(), codeEndDate: '2099-01-01', campaign: { claimEndDate: '2020-01-01' } }];
  const result = await fetchChzzkDrops();
  assert.equal(result.drops.length, 1); assert.equal(result.drops[0].couponCode, null);
});
test('missing CHZZK and SOOP coupon codes fail without hiding or logging', async () => {
  mode = 'coupon-missing';
  await storage.saveCachedDrops([coupon()], {});
  await assert.rejects(claimUnifiedDrop(coupon()), /쿠폰 코드/);
  await assert.rejects(claimSoopDrop(1), /쿠폰 코드/);
  assert.equal(Object.keys(await storage.getHandledDropsLog()).length, 0);
  assert.equal((await storage.getCachedDrops()).drops.length, 1);
});
test('successful coupon claim is saved before copy and can be marked copied later', async () => {
  await storage.saveCachedDrops([coupon()], {});
  await worker.handleMessage({ type: 'CLAIM_DROP', id: 'c1' });
  assert.equal((await storage.getHandledDropsLog()).c1.actionType, 'saved');
  assert.equal((await storage.getCachedDrops()).drops.length, 0);
  await worker.handleMessage({ type: 'RECORD_COPIED', id: 'c1', actionType: 'copied' });
  assert.equal((await storage.getHandledDropsLog()).c1.actionType, 'copied');
});
test('Twitch missing IDs and unknown statuses never succeed', async () => {
  await assert.rejects(claimTwitchDrop(null), /ID/);
  mode = 'unknown'; await assert.rejects(claimTwitchDrop('instance-B'), /NOT_ELIGIBLE/);
  assert.deepEqual(mutations, ['instance-B']);
});
test('Twitch claim reuses integrity and session headers captured from a real Twitch page', async () => {
  let claimHeaders = null;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/gql')) {
      const body = JSON.parse(options.body);
      if (body.operationName === 'HubDropsClaimViewer') return mockFetch(url, options);
      if (body.operationName === 'Inventory') return json({ data: { currentUser: { inventory: { dropCampaignsInProgress: campaigns } } } });
      claimHeaders = options.headers;
      mutations.push(body.variables.input.dropInstanceID);
      return json({ data: { claimDropRewards: { status: 'SUCCESS' } } });
    }
    return mockFetch(url, options);
  };
  assert.equal((await claimTwitchDrop('instance-B')).success, true);
  assert.equal(claimHeaders['Client-Integrity'], 'mock-integrity');
  assert.equal(claimHeaders['Client-Session-Id'], 'mock-session');
  assert.equal(claimHeaders['Client-Version'], 'mock-version');
  assert.equal(claimHeaders['Device-ID'], 'mock-device');
  assert.equal(claimHeaders['Content-Type'], 'application/json');
  assert.deepEqual(mutations, ['instance-B']);
});

test('Twitch webRequest listener captures only usable headers from a real Twitch tab', async () => {
  await twitchHeaders.clearCapturedTwitchGqlHeaders();
  listeners.webRequestSendHeaders({
    method: 'POST',
    tabId: 21,
    requestHeaders: [
      { name: 'Authorization', value: 'OAuth fresh-auth' },
      { name: 'Client-Id', value: 'client' },
      { name: 'Client-Integrity', value: 'fresh-integrity' },
      { name: 'Client-Session-Id', value: 'fresh-session' },
      { name: 'Ignored-Header', value: 'nope' },
    ],
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const captured = await twitchHeaders.getCapturedTwitchGqlHeaders();
  assert.equal(captured.headers['Client-Integrity'], 'fresh-integrity');
  assert.equal(captured.headers['Client-Session-Id'], 'fresh-session');
  assert.equal(captured.headers['Ignored-Header'], undefined);
});

test('Twitch refreshes captured page headers after an integrity rejection and retries once', async () => {
  let gqlCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (!url.endsWith('/gql')) return mockFetch(url, options);
    const body = JSON.parse(options.body);
    if (body.operationName === 'HubDropsClaimViewer') return mockFetch(url, options);
    gqlCalls++;
    if (gqlCalls === 1) {
      assert.equal(options.headers['Client-Integrity'], 'mock-integrity');
      return json({ errors: [{ message: 'failed integrity check' }] });
    }
    assert.equal(options.headers['Client-Integrity'], 'fresh-integrity');
    mutations.push(body.variables.input.dropInstanceID);
    return json({ data: { claimDropRewards: { status: 'SUCCESS' } } });
  };
  chrome.tabs.query = async () => [{ id: 12, url: 'https://www.twitch.tv/drops/inventory' }];
  chrome.tabs.reload = async () => {
    listeners.webRequestSendHeaders({
      method: 'POST',
      tabId: 12,
      requestHeaders: [
        { name: 'Authorization', value: 'OAuth mock-token' },
        { name: 'Client-Id', value: 'client' },
        { name: 'Client-Integrity', value: 'fresh-integrity' },
        { name: 'Client-Session-Id', value: 'fresh-session' },
        { name: 'Client-Version', value: 'fresh-version' },
      ],
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  assert.equal((await claimTwitchDrop('instance-B')).success, true);
  assert.equal(gqlCalls, 2);
  assert.deepEqual(mutations, ['instance-B']);
});
test('Twitch needs exact completed watch duration and uses same expiry in popup', async () => {
  campaigns = [campaign()];
  campaigns[0].timeBasedDrops[0].self.currentMinutesWatched = 59.9;
  assert.equal((await fetchTwitchDrops()).drops.length, 0);
  campaigns[0].timeBasedDrops[0].self.currentMinutesWatched = 60;
  const drop = (await fetchTwitchDrops()).drops[0];
  assert.equal(drop.id, 'twitch_instance-B'); assert.equal(isActiveDrop(drop), true);
  campaigns[0].endAt = '2020-01-01T00:00:00Z';
  assert.equal((await fetchTwitchDrops()).drops.length, 0);
});
test('auto claim retries after transient failure and logs confirmed success', async () => {
  data.settings = { autoClaim: true, enableNotifications: false, pollingIntervalMinutes: 5 };
  campaigns = [campaign()]; mode = 'error';
  await worker.pollDrops(); assert.equal(mutations.length, 1);
  await worker.pollDrops(); assert.equal(mutations.length, 1); // backoff
  data.claimRetries['twitch_instance-B'].nextAt = 0;
  mode = 'success'; await worker.pollDrops(); assert.equal(mutations.length, 2);
  const entry = (await storage.getHandledDropsLog())['twitch_instance-B'];
  assert.equal(entry.actionType, 'claimed'); assert.equal(entry.campaignId, 'campaign');
  assert.equal(entry.timeBasedDropId, 'reward'); assert.equal(entry.twitchUserId, 'user-1');
  assert.ok(Number.isFinite(entry.claimedAt));
});

test('manual Twitch claim records exact account, campaign and tier and feeds the collection plan', async () => {
  campaigns = [campaign()];
  await fetchAllDrops();
  await worker.handleMessage({ type: 'CLAIM_DROP', id: 'twitch_instance-B' });
  const entry = (await storage.getHandledDropsLog())['twitch_instance-B'];
  assert.equal(entry.campaignId, 'campaign'); assert.equal(entry.timeBasedDropId, 'reward');
  assert.equal(entry.dropInstanceId, 'instance-B'); assert.equal(entry.twitchUserId, 'user-1');
  assert.equal(entry.claimStatus, 'SUCCESS'); assert.ok(entry.claimedAt <= Date.now());
  assert.equal(entry.couponCode, null); assert.equal((await storage.getCachedDrops()).drops.length, 0);
  const { summarizeTwitchCampaign } = await import('../src/services/twitch-collector-plan.js');
  const result = summarizeTwitchCampaign({ ...campaign(), status: 'ACTIVE', startAt: '2020-01-01',
    timeBasedDrops: [{ ...campaign().timeBasedDrops[0], self: null }] }, null, Date.now(),
    { twitchUserId: 'user-1', handled: await storage.getHandledDropsLog() });
  assert.equal(result.completed, true); assert.equal(result.claimedToday, 1);
});

test('Twitch account change is rejected before sending a claim mutation or writing history', async () => {
  campaigns = [campaign()]; const drop = (await fetchTwitchDrops()).drops[0];
  await assert.rejects(claimUnifiedDrop({ ...drop, twitchUserId: 'previous-user' }), /계정이 변경/);
  assert.equal(mutations.length, 0); assert.equal(Object.keys(await storage.getHandledDropsLog()).length, 0);
});

test('an unverified Twitch claim account cannot send a mutation or create a receipt', async () => {
  campaigns = [campaign()]; const drop = (await fetchTwitchDrops()).drops[0];
  globalThis.fetch = async (url, options) => JSON.parse(options.body).operationName === 'HubDropsClaimViewer' ?
    json({ data: { currentUser: null } }) : mockFetch(url, options);
  await assert.rejects(claimUnifiedDrop(drop), /수령 계정을 확인하지/);
  assert.equal(mutations.length, 0); assert.equal(Object.keys(await storage.getHandledDropsLog()).length, 0);
});

test('Twitch status report shows receipt metadata without exposing credentials or account/instance IDs', async () => {
  data.collectorState = { twitch: { twitchUserId: 'private-user', claimedToday: 1,
    campaigns: [{ title: 'Campaign', earned: 3, claimed: 0, pending: 3, total: 3 }] } };
  data['handled:twitch_private-instance'] = { platform: 'twitch', actionType: 'claimed', rewardName: 'Emoticon englishnoob',
    twitchUserId: 'private-user', dropInstanceId: 'private-instance', receivedAt: 123, secret: 'DO-NOT-COPY' };
  data.twitchGqlHeaders = { Authorization: 'OAuth DO-NOT-COPY' };
  const report = await worker.handleMessage({ type: 'GET_TWITCH_STATUS_REPORT' });
  assert.equal(report.receipts[0].hasAccountId, true); assert.equal(report.receipts[0].hasCampaignId, false);
  assert.equal(report.receipts[0].accountMatches, true); assert.equal(report.campaigns[0].pending, 3);
  assert.equal(/DO-NOT-COPY|private-user|private-instance|Authorization/.test(JSON.stringify(report)), false);
});

test('Twitch inventory without an account ID retries raw query and cannot report unverified rewards', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return json({ data: { currentUser: { inventory: { dropCampaignsInProgress: [campaign()] } } } });
  };
  const result = await fetchTwitchDrops();
  assert.equal(calls, 2); assert.equal(result.loggedIn, null);
  assert.match(result.error, /조회 계정을 확인하지/); assert.deepEqual(result.drops, []);
});

test('failed Twitch claim leaves the card and never writes a completed receipt', async () => {
  campaigns = [campaign()]; await fetchAllDrops(); mode = 'unknown';
  await assert.rejects(worker.handleMessage({ type: 'CLAIM_DROP', id: 'twitch_instance-B' }), /NOT_ELIGIBLE/);
  assert.equal(Object.keys(await storage.getHandledDropsLog()).length, 0);
  assert.equal((await storage.getCachedDrops()).drops.length, 1);
});

test('already-claimed Twitch receipt preserves completion without inventing its claim date', async () => {
  campaigns = [campaign()]; const drop = (await fetchTwitchDrops()).drops[0]; mode = 'already-claimed';
  await claimUnifiedDrop(drop);
  const entry = (await storage.getHandledDropsLog())[drop.id];
  assert.equal(entry.actionType, 'claimed'); assert.equal(entry.claimedAt, null);
  assert.ok(Number.isFinite(entry.claimConfirmedAt)); assert.equal(entry.twitchUserId, 'user-1');
});
test('discovery while auto claim disabled does not block enabling later', async () => {
  campaigns = [campaign()];
  data.settings = { autoClaim: false, enableNotifications: true, pollingIntervalMinutes: 10 };
  await worker.pollDrops(); assert.equal(mutations.length, 0); assert.equal(notifications.length, 1);
  data.settings.autoClaim = true;
  await worker.pollDrops(); assert.equal(mutations.length, 1);
});
test('settings change recreates alarm and rejects unsupported interval', async () => {
  alarms.set('checkDropsAlarm', { periodInMinutes: 10 });
  await worker.handleMessage({ type: 'UPDATE_SETTINGS', settings: { pollingIntervalMinutes: 5 } });
  assert.equal(alarms.get('checkDropsAlarm').periodInMinutes, 5);
  await assert.rejects(worker.handleMessage({ type: 'UPDATE_SETTINGS', settings: { pollingIntervalMinutes: 0 } }));
});
test('obsolete Twitch manual choices are no longer accepted',async()=>{
 await assert.rejects(worker.handleMessage({type:'SET_TWITCH_CAMPAIGN_OVERRIDE',id:'campaign-1',mode:'completed'}),/지원하지 않는 요청/);
});
test('updating removes obsolete settings and manual Twitch choices while preserving reward records',async()=>{
 data.appVersion='1.5.17-old';data.settings={autoCollectSoop:true,autoCollectChzzk:true,autoCollectTwitch:true};
 data.twitchCampaignOverrides={'viewer:campaign-1':{mode:'completed'}};
 data['handled:soop_old']={couponCode:'KEEP'};
 await storage.initializeStorage();
 assert.equal(data.settings.autoCollectSoop,undefined);
 assert.equal(data.settings.autoCollectChzzk,true);assert.equal(data.settings.autoCollectTwitch,true);
 assert.equal(data.twitchCampaignOverrides,undefined);assert.equal(data['handled:soop_old'].couponCode,'KEEP');
});
test('failed refresh keeps cached SOOP cards stale, with claims disabled', async () => {
  const old = { ...coupon('soop'), platform: 'soop' };
  await storage.saveCachedDrops([old], {}); soopHtml = true;
  const result = await fetchAllDrops();
  assert.equal(result.drops.length, 1); assert.equal(result.drops[0].stale, true);
  await assert.rejects(claimUnifiedDrop(result.drops[0]), /최신 목록/);
});
test('durable batch resumes saved remaining IDs and records both success and failure', async () => {
  await storage.saveCachedDrops([{ ...coupon(), couponCode: 'PERSISTED' }], {});
  data.batchJob = { id: 'job', status: 'running', remaining: ['c1', 'missing'], successCount: 0, errors: [] };
  await worker.processBatch();
  assert.equal(data.batchJob.status, 'complete'); assert.equal(data.batchJob.successCount, 1);
  assert.equal(data.batchJob.errors.length, 1); assert.equal(data['handled:c1'].couponCode, 'PERSISTED');
});
test('worker rejects website messages and accepts own extension pages only', () => {
  let response;
  assert.equal(listeners.message({ type: 'CLAIM_DROP' }, { id: 'test', tab: { id: 1 }, url: 'https://www.twitch.tv/' }, res => { response = res; }), false);
  assert.equal(response.success, false);
});
test('own extension page opened as a tab is accepted', async () => {
  const result = await new Promise(resolve => listeners.message({ type: 'GET_STATE' }, { id: 'test', tab: { id: 3 }, url: 'chrome-extension://test/popup/popup.html' }, resolve));
  assert.equal(result.success, true);
});
test('no content script auto-clicks or inline popup event handlers remain', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
  assert.equal(manifest.content_scripts, undefined);
  const popup = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(popup, /onerror=|\.innerHTML\s*=/);
});
test('request timeout covers a stalled response body', async () => {
  globalThis.fetch = async (_url, { signal }) => ({ arrayBuffer: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(fetchWithTimeout('https://test.invalid', {}, 10), /aborted/);
});

test('CHZZK preserves all six earned Sep 8/9 rewards after the calendar cutoff', async () => {
  chzzkClaims = Array.from({ length: 6 }, (_, i) => ({ rewardNo: i + 1, rewardName: 'Reward ' + i, rewardType: 'CODE', fulfillmentState: 'COMPLETED', createdDate: `2026-09-${i < 3 ? '08' : '09'} 12:00:00`, codeEndDate: '2099-01-01', campaign: { state: 'TERMINATED', endDate: '2026-09-09', claimEndDate: '2026-09-09' } }));
  const result = await fetchAllDrops();
  assert.equal(result.drops.filter(d => d.platform === 'chzzk').length, 6);
  for (const drop of result.drops) assert.equal(isActiveDrop(drop, {}, Date.parse('2026-09-10T12:00:00+09:00')), true);
});
test('CHZZK cached acquisition date does not hide an unexpired reward', () => {
  assert.equal(isActiveDrop({ ...coupon(), recentDate: '2026-09-08T00:00:00Z' }, {}, Date.parse('2026-09-10T12:00:00+09:00')), true);
});
test('CHZZK still excludes genuinely expired coupons and completed in-app rewards', async () => {
  chzzkClaims = [
    { rewardNo: 1, rewardType: 'CODE', codeEndDate: '2020-01-01' },
    { rewardNo: 2, rewardType: 'IN_APP', fulfillmentState: 'COMPLETED' },
    { rewardNo: 3, rewardType: 'IN_APP', fulfillmentState: 'COMPLIED', campaign: { endDate: '2020-01-01', claimEndDate: '2099-01-01' } },
  ];
  assert.deepEqual((await fetchChzzkDrops()).drops.map(d => d.rewardNo), [3]);
});
test('Twitch explicit null campaigns are a valid empty inventory', async () => {
  campaigns = null;
  const result = await fetchTwitchDrops();
  assert.equal(result.error, null); assert.equal(result.loggedIn, true); assert.deepEqual(result.drops, []);
});
test('Twitch unrelated field errors do not discard available campaigns', () => {
  const result = decodeInventoryResponse({ data: { currentUser: { inventory: { dropCampaignsInProgress: [campaign()] } } }, errors: [{ message: 'Other rewards failed', path: ['currentUser', 'inventory', 'gameEventDrops'] }] });
  assert.equal(result.error, null); assert.equal(result.campaigns.length, 1);
});
test('Twitch missing or malformed campaigns still fail, not empty success', () => {
  for (const inventory of [null, {}, { dropCampaignsInProgress: {} }]) {
    assert.ok(decodeInventoryResponse({ data: { currentUser: { inventory } } }).error);
  }
  assert.match(decodeInventoryResponse({ data: { currentUser: { inventory: { dropCampaignsInProgress: null } } }, errors: [{ message: 'service error', path: ['currentUser', 'inventory', 'dropCampaignsInProgress'] }] }).error, /service error/);
});
test('Twitch malformed persisted response retries raw inventory query', async () => {
  let count = 0;
  globalThis.fetch = async (url, opts) => {
    if (url.endsWith('/gql')) {
      count++;
      const body = JSON.parse(opts.body);
      return json({ data: { currentUser: { id: 'user-1', inventory: body.query ? { dropCampaignsInProgress: [campaign()] } : {} } } });
    }
    return mockFetch(url, opts);
  };
  assert.equal((await fetchTwitchDrops()).drops.length, 1); assert.equal(count, 2);
});



test('claiming a coupon does not make the remaining inventory look newly fetched',async()=>{
 data.lastUpdated=123;data.dropsCache=[{...coupon(),couponCode:'CODE'},coupon('c2')];
 await claimUnifiedDrop(data.dropsCache[0]);
 assert.equal(data.lastUpdated,123);assert.deepEqual(data.dropsCache.map(d=>d.id),['c2']);
});
test('settings OFF is applied even while the claim queue is blocked',async()=>{
 data.settings={liveMonitorEnabled:true};
 let release; const gate=new Promise(resolve=>{release=resolve;});
 const blocked=worker.enqueue(()=>gate);
 try {
   const result=await Promise.race([
     new Promise(resolve=>listeners.message({type:'UPDATE_SETTINGS',settings:{liveMonitorEnabled:false}},{id:'test',url:'chrome-extension://test/popup/popup.html'},resolve)),
     new Promise((_,reject)=>setTimeout(()=>reject(Error('settings blocked by claim queue')),500))
   ]);
   assert.equal(result.success,true);assert.equal(data.settings.liveMonitorEnabled,false);
 } finally {release();await blocked;}
});

test('copying an old coupon preserves its original received date',async()=>{
 data['handled:old']={...coupon('old'),couponCode:'OLD',handledAt:123,actionType:'saved'};
 await storage.recordHandledDrop(coupon('old'),'copied');
 assert.equal(data['handled:old'].receivedAt,123);
 await storage.recordHandledDrop(coupon('old'),'copied');
 assert.equal(data['handled:old'].receivedAt,123);
});


test('Twitch campaign MMDD labels provide a display date with year rollover',async()=>{
 const {campaignDisplayDate}=await import('../src/services/campaign-date.js');
 assert.equal(campaignDisplayDate('MID SEASON DROPS [0917]','2026-09-18T04:59:00+09:00'),'2026-09-17');
 assert.equal(campaignDisplayDate('Drops [1231]','2027-01-01T04:59:00+09:00'),'2026-12-31');
 assert.equal(campaignDisplayDate('Drops [0101]','2026-12-31T23:59:00+09:00'),'2027-01-01');
 assert.equal(campaignDisplayDate('Drops [0230]','2026-03-01T00:00:00+09:00'),null);
 assert.equal(campaignDisplayDate('Drops','2026-09-18T00:00:00+09:00'),null);
});
test('Twitch inventory retains campaign display date separately from acquisition',async()=>{
 campaigns=[{...campaign(),name:'MID SEASON DROPS [0917]',endAt:'2099-09-18T04:59:00+09:00'}];
 const result=await fetchTwitchDrops();
 assert.equal(result.drops[0].campaignDate,'2099-09-17');
 assert.equal(result.drops[0].acquiredAt,undefined);
});


test('Twitch display date falls back to individual drop startAt, then campaign startAt',async()=>{
 campaigns=[{...campaign(),name:'Drops Token',startAt:'2099-09-18T15:00:00Z',timeBasedDrops:[{...campaign().timeBasedDrops[0],startAt:'2099-09-19T15:30:00Z'}]}];
 let result=await fetchTwitchDrops();
 assert.equal(result.drops[0].campaignDate,'2099-09-20');
 campaigns=[{...campaign(),name:'Drops Token',startAt:'2099-09-18T15:00:00Z'}];
 result=await fetchTwitchDrops();
 assert.equal(result.drops[0].campaignDate,'2099-09-19');
});


test('automatic polling leaves CHZZK and SOOP coupons available even with autoClaim ON',async()=>{
 data.settings={autoClaim:true,enableNotifications:true};
 chzzkClaims=[{rewardNo:10,rewardType:'CODE',code:'A'}];
 soopAvailable=[{itemCodeIdx:1,cateName:'이터널 리턴',itemCode:'ER'}];
 await worker.pollDrops();
 assert.equal(data['handled:chzzk_10'],undefined);assert.equal(data['handled:soop_inv_1'],undefined);
 assert.ok(data.dropsCache.some(d=>d.id==='chzzk_10'));assert.ok(data.dropsCache.some(d=>d.id==='soop_inv_1'));
 assert.equal(notifications.filter(n=>n.id.startsWith('available:')).length,2);
});
test('explicit manual CHZZK and SOOP coupon actions still work',async()=>{
 data.settings={autoClaim:true};
 chzzkClaims=[{rewardNo:10,rewardType:'CODE',code:'A'}];
 soopAvailable=[{itemCodeIdx:1,cateName:'이터널 리턴',itemCode:'ER'}];
 await fetchAllDrops();
 await worker.handleMessage({type:'CLAIM_DROP',id:'chzzk_10'});
 await worker.handleMessage({type:'CLAIM_DROP',id:'soop_inv_1'});
 assert.equal(data['handled:chzzk_10'].couponCode,'A');assert.equal(data['handled:soop_inv_1'].couponCode,'ER');
});
test('collector settings reject invalid campaign IDs and nonboolean toggles',async()=>{
 await assert.rejects(storage.saveSettings({chzzkCollectCampaign:'../bad'}));
 await assert.rejects(storage.saveSettings({autoCollectChzzk:'yes'}));
 await storage.saveSettings({chzzkCollectCampaign:'1796',autoCollectChzzk:true});
 assert.equal((await storage.getSettings()).chzzkCollectCampaign,'1796');
});
