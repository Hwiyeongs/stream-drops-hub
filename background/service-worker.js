import { COLLECT_ALARM, ensureCollectorAlarm, checkCollector } from '../src/services/auto-collector.js';
import { fetchCampaignCatalog } from '../src/services/collector-plans.js';
import { registerTwitchHeaderCapture } from '../src/services/twitch-headers.js';
import { LIVE_ALARM, ensureLiveAlarm, checkLiveMonitor, openLiveNotification } from '../src/services/live-monitor.js';
import { fetchAllDrops, claimUnifiedDrop } from '../src/services/aggregator.js';
import { getSettings, saveSettings, initializeStorage, purgeExpiredHandledDrops, getCachedDrops, getHandledDropsLog, recordHandledDrop } from '../src/services/storage.js';

registerTwitchHeaderCapture();

const ALARM = 'checkDropsAlarm', BATCH_ALARM = 'continueDropsBatch';
// One worker owns all writes and claims; queue remains usable after errors.
let tail = Promise.resolve();
export function enqueue(task) {
  const pending = tail.then(task);
  tail = pending.catch(() => {});
  return pending;
}
const schedule = task => { void enqueue(task).catch(error => console.error('[Drops Hub]', error)); };
export async function ensureAlarm() {
  const settings = await getSettings();
  const alarm = await chrome.alarms.get(ALARM);
  if (alarm?.periodInMinutes !== settings.pollingIntervalMinutes) {
    await chrome.alarms.create(ALARM, { periodInMinutes: settings.pollingIntervalMinutes });
  }
}
export async function initialize() {
  await initializeStorage();
  await ensureAlarm();
  await ensureLiveAlarm();
  await ensureCollectorAlarm();
  await purgeExpiredHandledDrops();
}
const runCollector = (afterCurrent = false) => { void checkCollector(afterCurrent).catch(console.error); };

async function claimById(id) {
  if (typeof id !== 'string') throw new Error('보상 ID가 올바르지 않습니다.');
  const handled = (await getHandledDropsLog())[id];
  if (handled) return { success: true, itemCode: handled.couponCode, alreadyHandled: true };
  let cache = await getCachedDrops();
  if (!cache.lastUpdated || Date.now() - cache.lastUpdated > 60000 || cache.drops.find(d => d.id === id)?.stale) cache = await fetchAllDrops();
  const drop = cache.drops.find(d => d.id === id);
  if (!drop) throw new Error('보상이 목록에 없습니다. 새로고침 후 확인해 주세요.');
  return claimUnifiedDrop(drop);
}
async function notify(id, title, message) {
  await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'), title, message });
}
export async function pollDrops() {
  await initialize();
  const result = await fetchAllDrops();
  const data = await chrome.storage.local.get(['notifiedDropIds', 'claimRetries']);
  const currentIds = new Set(result.drops.map(d => d.id));
  const notified = new Set((data.notifiedDropIds || []).filter(id => currentIds.has(id)));
  const retries = Object.fromEntries(Object.entries(data.claimRetries || {}).filter(([id]) => currentIds.has(id)));
  for (const drop of result.drops) {
    if (drop.stale) continue;
    const settings = await getSettings();
    const autoClaim = settings.autoClaim && drop.platform === 'twitch';
    if (autoClaim && (!retries[drop.id] || retries[drop.id].nextAt <= Date.now())) {
      try {
        await claimUnifiedDrop(drop);
        delete retries[drop.id];
        if (settings.enableNotifications) {
          try { await notify('claimed:' + drop.id, `[처리 완료] ${drop.platformName}`, `${drop.rewardName}: ${drop.isCoupon ? '쿠폰 코드를 기록에 보관했습니다.' : '수령했습니다.'}`); } catch (error) { console.warn('Notification unavailable', error.message); }
        }
      } catch (error) {
        const attempts = (retries[drop.id]?.attempts || 0) + 1;
        retries[drop.id] = { attempts, nextAt: Date.now() + Math.min(60, 5 * 2 ** Math.min(attempts - 1, 4)) * 60000, error: error.message };
      }
    } else if (!autoClaim && settings.enableNotifications && !notified.has(drop.id)) {
      try {
        await notify('available:' + drop.id, `[드롭스 달성] ${drop.platformName}`, `${drop.rewardName}: 수령할 수 있습니다.`);
        notified.add(drop.id);
      } catch (error) { console.warn('Notification unavailable', error.message); }
    }
    await chrome.storage.local.set({ claimRetries: retries, notifiedDropIds: [...notified] });
  }
  await chrome.storage.local.set({ claimRetries: retries, notifiedDropIds: [...notified] });
}

// Persist remaining IDs before starting, allowing recovery after worker/browser restart.
export async function processBatch() {
  let { batchJob } = await chrome.storage.local.get('batchJob');
  if (!batchJob || batchJob.status !== 'running') return;
  await chrome.alarms.create(BATCH_ALARM, { delayInMinutes: 0.5 });
  while (batchJob.remaining.length) {
    const id = batchJob.remaining[0];
    try {
      await claimById(id);
      batchJob.successCount++;
    } catch (error) { batchJob.errors.push({ id, message: error.message }); }
    batchJob.remaining.shift();
    await chrome.storage.local.set({ batchJob });
    // Keep recovery alarm scheduled if a long batch spans the previous alarm.
    await chrome.alarms.create(BATCH_ALARM, { delayInMinutes: 0.5 });
  }
  batchJob.status = 'complete';
  batchJob.finishedAt = Date.now();
  await chrome.storage.local.set({ batchJob });
  await chrome.alarms.clear(BATCH_ALARM);
}

// Settings must remain responsive while network claims are queued.
let settingsTail = Promise.resolve();
function updateSettings(values) {
  const task = settingsTail.then(async () => {
    const settings = await saveSettings(values || {});
    await ensureAlarm();
    await ensureLiveAlarm();
  await ensureCollectorAlarm();
    if (settings.liveMonitorEnabled) void checkLiveMonitor().catch(console.error);
    runCollector(true);
    return settings;
  });
  settingsTail = task.catch(() => {});
  return task;
}

export async function handleMessage(message) {
  await initialize();
  switch (message.type) {
    case 'GET_COLLECTOR_CATALOG': {
      const catalog = await fetchCampaignCatalog();
      await chrome.storage.local.set({ collectorCatalog: catalog });
      return catalog;
    }
    case 'GET_STATE': return { ...await getCachedDrops(), settings: await getSettings() };
    case 'REFRESH_ALL': return fetchAllDrops();
    case 'CLAIM_DROP': return claimById(message.id);
    case 'RECORD_COPIED': {
      if (message.actionType !== 'copied') throw new Error('지원하지 않는 기록 작업입니다.');
      const cache = await getCachedDrops();
      const entry = (await getHandledDropsLog())[message.id] || cache.drops.find(d => d.id === message.id);
      if (!entry?.couponCode) throw new Error('보관된 쿠폰 코드가 없습니다.');
      await recordHandledDrop(entry, 'copied');
      const current = await getCachedDrops();
      await chrome.storage.local.set({ dropsCache: current.drops.filter(d => d.id !== entry.id) });
      return { success: true };
    }
    case 'UPDATE_SETTINGS': return updateSettings(message.settings);
    case 'SET_TWITCH_CAMPAIGN_OVERRIDE': {
      if (typeof message.id !== 'string' || !message.id || message.id.length > 120 ||
          !['completed', 'watch', 'auto'].includes(message.mode)) throw new Error('트위치 캠페인 선택이 올바르지 않습니다.');
      const { collectorState = {}, twitchCampaignOverrides = {} } = await chrome.storage.local.get(['collectorState', 'twitchCampaignOverrides']);
      const session = collectorState.twitch;
      const campaign = session?.campaigns?.find(c => c.id === message.id && c.active);
      if (!campaign || !/^[a-z0-9_]{1,25}$/i.test(session.account || '') ||
          !Number.isFinite(campaign.endAt) || !Number.isFinite(session.campaignsCheckedAt) ||
          Date.now() - session.campaignsCheckedAt > 3 * 60000) throw new Error('현재 트위치 캠페인 목록을 다시 확인해 주세요.');
      const overrides = twitchCampaignOverrides && typeof twitchCampaignOverrides === 'object' &&
        !Array.isArray(twitchCampaignOverrides) ? { ...twitchCampaignOverrides } : {};
      const key = `${session.account}:${campaign.id}`;
      if (message.mode === 'auto') delete overrides[key];
      else overrides[key] = { endAt: campaign.endAt, mode: message.mode, markedAt: Date.now() };
      await chrome.storage.local.set({ twitchCampaignOverrides: overrides });
      await checkCollector(true);
      return { success: true };
    }
    case 'CLAIM_ALL': {
      const existing = (await chrome.storage.local.get('batchJob')).batchJob;
      if (existing?.status === 'running') return existing;
      if (!Array.isArray(message.ids) || message.ids.some(id => typeof id !== 'string')) throw new Error('수령 목록이 올바르지 않습니다.');
      const batchJob = { id: crypto.randomUUID(), status: 'running', remaining: [...new Set(message.ids)], successCount: 0, errors: [], startedAt: Date.now() };
      await chrome.storage.local.set({ batchJob });
      await chrome.alarms.create(BATCH_ALARM, { delayInMinutes: 0.5 });
      // Queue after replying so closing the popup cannot cancel the batch.
      schedule(processBatch);
      return batchJob;
    }
    default: throw new Error('지원하지 않는 요청입니다.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own pages may trigger claims/settings writes.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    sendResponse({ success: false, error: '허용되지 않은 요청입니다.' });
    return false;
  }
  const task = message?.type === 'UPDATE_SETTINGS' ? updateSettings(message.settings) : enqueue(() => handleMessage(message));
  task.then(data => sendResponse({ success: true, data }), error => sendResponse({ success: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === COLLECT_ALARM) runCollector();
  if (alarm.name === LIVE_ALARM) void checkLiveMonitor().catch(console.error);
  if (alarm.name === ALARM) schedule(pollDrops);
  if (alarm.name === BATCH_ALARM) schedule(async () => { await initialize(); await processBatch(); });
});
chrome.runtime.onInstalled.addListener(() => { schedule(async () => { await initialize(); await fetchAllDrops(); }); });
chrome.runtime.onStartup.addListener(() => { schedule(async () => { await initialize(); await processBatch(); void checkLiveMonitor().catch(console.error); runCollector(); }); });
// Recreate missing alarms whenever the worker wakes; register listeners synchronously first.
schedule(initialize);

chrome.notifications.onClicked.addListener(id => { void openLiveNotification(id).catch(console.error); });
