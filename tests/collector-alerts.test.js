import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkCollectorAlerts } from '../src/services/collector-alerts.js';
let data, notices, failNotification;
const base = Date.parse('2026-10-03T04:58:00+09:00');
const minute = 60000;
beforeEach(() => {
  data = { settings: { collectorFailureAlerts: true, autoCollectChzzk: true, autoCollectTwitch: true }, collectorState: {} };
  notices = []; failNotification = false;
  globalThis.chrome = { runtime: { getURL: path => 'extension/' + path }, storage: { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
  } }, notifications: { async create(id, values) { if (failNotification) throw Error('PRIVATE'); notices.push({ id, ...values }); } } };
});
async function sample(offset, state = { phase: 'query_failed', queryReason: 'AUTH_REQUIRED' }, platform = 'chzzk') {
  const now = base + offset * minute;
  data.collectorState[platform] = { ...state, checkedAt: now };
  await checkCollectorAlerts(now);
}

test('three independent failures over two minutes notify once and survive the 05:00 reset', async () => {
  await sample(0); await sample(1); assert.equal(notices.length, 0);
  await sample(2); assert.equal(notices.length, 1);
  await sample(3); await sample(1442); assert.equal(notices.length, 1);
  assert.equal(data.collectorAlertState.chzzk.notified, true);
  assert.match(notices[0].message, /인증 확인/);
});
test('duplicate samples and concurrent calls cannot satisfy the failure threshold or duplicate a notification', async () => {
  await sample(0);
  await Promise.all(Array.from({ length: 5 }, () => checkCollectorAlerts(base)));
  assert.equal(data.collectorAlertState.chzzk.samples, 1);
  await sample(1); await sample(2);
  await Promise.all(Array.from({ length: 5 }, () => checkCollectorAlerts(base + 2 * minute)));
  assert.equal(notices.length, 1);
});
test('healthy recovery permits a later new incident; expected wait and manual pause do not alert', async () => {
  for (const phase of ['waiting_live', 'waiting_other_tab', 'waiting_claim', 'complete', 'loading', 'paused', 'off']) {
    for (let i = 0; i < 3; i++) await sample(i, { phase });
  }
  for (let i = 0; i < 3; i++) await sample(i, { phase: 'playback_retry', diagnostic: { state: 'interrupted' } });
  for (let i = 0; i < 3; i++) await sample(i, { phase: 'query_failed', userStopped: true });
  assert.equal(notices.length, 0);
  await sample(0); await sample(1); await sample(2);
  await sample(3, { phase: 'playing' });
  await sample(4); await sample(5); await sample(6);
  assert.equal(notices.length, 2);
});
test('browser sleep gaps, clock reversal and stale state cannot establish continuous failure', async () => {
  await sample(0); await sample(1); await sample(10);
  assert.equal(notices.length, 0); assert.equal(data.collectorAlertState.chzzk.samples, 1);
  await sample(9); assert.equal(data.collectorAlertState.chzzk.samples, 1);
  await checkCollectorAlerts(base + 30 * minute); assert.equal(notices.length, 0);
  data.collectorState.chzzk.checkedAt = base + 100 * minute;
  await checkCollectorAlerts(base + 31 * minute); assert.equal(notices.length, 0);
});
test('disabled alerts and disabled collectors do not notify', async () => {
  data.settings.collectorFailureAlerts = false;
  await sample(0); await sample(1); await sample(2); assert.equal(notices.length, 0);
  data.settings.collectorFailureAlerts = true; data.settings.autoCollectChzzk = false;
  await sample(3); await sample(4); await sample(5); assert.equal(notices.length, 0);
});
test('notification failure remains retryable and one platform cannot suppress the other', async () => {
  failNotification = true; await sample(0); await sample(1); await sample(2);
  assert.equal(data.collectorAlertState.chzzk.notified, false);
  failNotification = false; await sample(3); assert.equal(notices.length, 1);
  await sample(3, undefined, 'twitch'); await sample(4, undefined, 'twitch'); await sample(5, undefined, 'twitch');
  assert.equal(notices.length, 2); assert.equal(notices[1].id, 'collector-issue:twitch');
});
test('repeated playback and confirmed stagnation alert with sanitized static text and minimal persisted state', async () => {
  for (let i = 0; i < 3; i++) await sample(i, { phase: 'switch_pending',
    diagnostic: { state: 'blocked', reason: 'NotAllowedError' }, status: 'PRIVATE-URL', error: 'PRIVATE-TOKEN', campaignId: 'PRIVATE-ID' });
  assert.equal(notices.length, 1); assert.match(notices[0].message, /재생 복구/);
  assert.equal(/PRIVATE/.test(JSON.stringify({ notices, stored: data.collectorAlertState })), false);
  await sample(3, { phase: 'playing' });
  for (let i = 4; i < 7; i++) await sample(i, { phase: 'stalled_waiting' });
  assert.equal(notices.length, 2); assert.match(notices[1].message, /정체/);
});