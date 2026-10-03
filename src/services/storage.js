/** Background-owned writes; per-item keys prevent unrelated records overwriting each other. */
const DEFAULT_SETTINGS = { pollingIntervalMinutes: 10, enableNotifications: true, autoClaim: false, liveMonitorEnabled: false, liveAutoOpen: false, autoCollectChzzk: false, autoCollectTwitch: false, chzzkCollectCampaign: 'auto' };
const HANDLED = 'handled:', COUPON = 'coupon:', HIDDEN = 'hidden:';
export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const result = { ...DEFAULT_SETTINGS, ...settings };
  delete result.autoCollectSoop;
  delete result.eternalReturnOnly;
  return result;
}
export async function saveSettings(values) {
  const settings = { ...await getSettings() };
  if ('pollingIntervalMinutes' in values) {
    if (![5, 10, 15, 30].includes(values.pollingIntervalMinutes)) throw new Error('지원하지 않는 확인 주기입니다.');
    settings.pollingIntervalMinutes = values.pollingIntervalMinutes;
  }
  for (const key of ['enableNotifications', 'autoClaim', 'liveMonitorEnabled', 'liveAutoOpen', 'autoCollectChzzk', 'autoCollectTwitch']) {
    if (key in values) {
      if (typeof values[key] !== 'boolean') throw new Error('설정 값이 올바르지 않습니다.');
      settings[key] = values[key];
    }
  }
  if ('chzzkCollectCampaign' in values) {
    if (typeof values.chzzkCollectCampaign !== 'string' || !/^(auto|[1-9][0-9]*)$/.test(values.chzzkCollectCampaign)) throw new Error('캠페인 선택 값이 올바르지 않습니다.');
    settings.chzzkCollectCampaign = values.chzzkCollectCampaign;
  }
  await chrome.storage.local.set({ settings });
  return settings;
}
export async function getCachedDrops() {
  const data = await chrome.storage.local.get(['dropsCache', 'lastUpdated', 'platformStatuses']);
  return { drops: data.dropsCache || [], lastUpdated: data.lastUpdated || null, platformStatuses: data.platformStatuses || {} };
}
export async function saveCachedDrops(drops, platformStatuses) {
  const lastUpdated = Date.now();
  await chrome.storage.local.set({ dropsCache: drops, platformStatuses, lastUpdated });
  return { drops, platformStatuses, lastUpdated };
}
export async function initializeStorage() {
  const data = await chrome.storage.local.get(null);
  if (!data.itemStorageMigrated) {
    const migrated = {};
    for (const [id, entry] of Object.entries(data.handledDropsLog || {})) {
      if (!data[HANDLED + id]) migrated[HANDLED + id] = entry;
    }
    for (const [id, code] of Object.entries(data.savedCouponCodes || {})) {
      if (!data[COUPON + id]) migrated[COUPON + id] = code;
    }
    await chrome.storage.local.set({ ...migrated, itemStorageMigrated: true });
    await chrome.storage.local.remove(['handledDropsLog', 'savedCouponCodes']);
  }
  const version = chrome.runtime.getManifest().version;
  if (data.appVersion !== version) {
    await chrome.storage.local.remove(['dropsCache', 'cachedDrops', 'lastUpdated', 'platformStatuses', 'twitchCampaignOverrides']);
    await chrome.storage.local.set({ appVersion: version, settings: await getSettings() });
  }
}
export async function getSavedCouponCodes() {
  const data = await chrome.storage.local.get(null);
  return Object.fromEntries(Object.entries(data).filter(([k]) => k.startsWith(COUPON)).map(([k, v]) => [k.slice(COUPON.length), v]));
}
export async function saveCouponCode(key, code) {
  if (key == null || typeof code !== 'string' || !code.trim()) throw new Error('쿠폰 코드가 없습니다.');
  await chrome.storage.local.set({ [COUPON + key]: code.trim() });
}
const KST = 9 * 60 * 60 * 1000, DAY = 24 * 60 * 60 * 1000;
/** Platform dates without a timezone use KST; expiry dates include the whole day. */
export function parseTimestamp(value, endOfDay = false) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 1e11 ? value * 1000 : value) : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const match = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if (match) {
    const [, y, m, d, h, min, sec, ms] = match;
    const check = new Date(Date.UTC(+y, +m - 1, +d));
    if (check.getUTCFullYear() !== +y || check.getUTCMonth() !== +m - 1 || check.getUTCDate() !== +d) return null;
    if (+(h || 0) > 23 || +(min || 0) > 59 || +(sec || 0) > 59) return null;
    const base = Date.UTC(+y, +m - 1, +d, +(h || 0), +(min || 0), +(sec || 0), +(ms || '').padEnd(3, '0')) - KST;
    return h === undefined && endOfDay ? base + DAY - 1 : base;
  }
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}
export function parseExpTimestamp(value) { return parseTimestamp(value, true); }
/** Twitch campaign end is a watch cutoff, not a claim deadline. Old expDate caches used that cutoff. */
export function parseDropClaimExpiry(drop) {
  return parseExpTimestamp(drop?.platform === 'twitch' ? drop.claimEndAt : drop?.expDate);
}
export function yesterdayStart(now = Date.now()) { return Math.floor((now + KST) / DAY) * DAY - KST - DAY; }
export function isRecentDate(value, now = Date.now()) {
  const time = parseTimestamp(value);
  return time !== null && time >= yesterdayStart(now) && time <= now;
}
export async function getHandledDropsLog() {
  const data = await chrome.storage.local.get(null);
  return Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith(HANDLED))
    .map(([key, entry]) => [key.slice(HANDLED.length), entry]));
}
export async function recordHandledDrop(drop, actionType = 'claimed') {
  if (!drop?.id) throw new Error('보상 ID가 없습니다.');
  const key = HANDLED + drop.id;
  const previous = (await chrome.storage.local.get(key))[key];
  const entry = { ...previous, ...drop, actionType, receivedAt: previous?.receivedAt ?? previous?.handledAt ?? Date.now(), handledAt: Date.now() };
  entry.couponCode = drop.couponCode || previous?.couponCode || null;
  if (previous?.actionType === 'copied' && actionType === 'saved') entry.actionType = 'copied';
  await chrome.storage.local.set({ [key]: entry });
  return entry;
}
export async function isDropHandled(id) { return !!(await getHandledDropsLog())[id]; }

export async function getHiddenDrops() {
  const data = await chrome.storage.local.get(null);
  return Object.fromEntries(Object.entries(data).filter(([key]) => key.startsWith(HIDDEN))
    .map(([key, entry]) => [key.slice(HIDDEN.length), entry]));
}
export async function hideDrop(drop) {
  if (!drop?.id || typeof drop.id !== 'string' || drop.id.length > 2048 || !['chzzk', 'soop', 'twitch'].includes(drop.platform)) throw new Error('숨길 보상 정보가 올바르지 않습니다.');
  // Keep a minimal display snapshot for restoring even when the server removes it.
  const entry = { id: drop.id, platform: drop.platform, hiddenAt: Date.now() };
  for (const field of ['platformName', 'rewardName', 'rewardImageUrl', 'gameTitle', 'campaignName', 'campaignUrl',
    'acquiredAt', 'recentDate', 'campaignDate', 'gameCategoryId', 'gameSlug', 'officialGameName']) {
    if (drop[field] != null) entry[field] = drop[field];
  }
  await chrome.storage.local.set({ [HIDDEN + drop.id]: entry });
  return entry;
}
export async function restoreDrop(id) {
  if (typeof id !== 'string' || !id || id.length > 2048) throw new Error('보상 ID가 올바르지 않습니다.');
  await chrome.storage.local.remove(HIDDEN + id);
}

/** Add verified identity to an existing receipt without changing any historical dates. */
export async function linkTwitchReceipt(id, identity) {
  const key = HANDLED + id;
  const previous = (await chrome.storage.local.get(key))[key];
  if (previous?.platform !== 'twitch' || previous.actionType !== 'claimed') return null;
  for (const field of ['twitchUserId', 'campaignId', 'timeBasedDropId', 'dropInstanceId']) {
    if (!identity[field] || (previous[field] && String(previous[field]) !== String(identity[field]))) return null;
  }
  const entry = { ...previous };
  for (const field of ['twitchUserId', 'campaignId', 'timeBasedDropId', 'dropInstanceId']) if (!entry[field]) entry[field] = String(identity[field]);
  entry.receiptIdentityVerified = true;
  await chrome.storage.local.set({ [key]: entry });
  return entry;
}

/** A user-copyable status report: field presence and states, never credentials or raw account/instance IDs. */
export async function getTwitchStatusReport() {
  const [{ collectorState = {} }, handled, cache] = await Promise.all([
    chrome.storage.local.get('collectorState'), getHandledDropsLog(), getCachedDrops(),
  ]);
  const state = collectorState.twitch || {};
  const describe = entry => ({ reward: entry.rewardName || null, campaign: entry.campaignName || null,
    action: entry.actionType || entry.status || null,
    receivedAt: entry.receivedAt ?? null, claimedAt: entry.claimedAt ?? null,
    hasAccountId: !!entry.twitchUserId, hasCampaignId: !!entry.campaignId,
    hasDropId: !!entry.timeBasedDropId, hasInstanceId: !!entry.dropInstanceId,
    accountMatches: state.twitchUserId && entry.twitchUserId ? String(state.twitchUserId) === String(entry.twitchUserId) : null,
    identityVerified: entry.receiptIdentityVerified === true });
  return { version: chrome.runtime.getManifest().version, checkedAt: state.campaignsCheckedAt ?? null,
    status: state.status || null, queryFailed: !!state.error,
    todayReceiptCount: state.claimedToday ?? null,
    campaigns: (state.campaigns || []).map(c => ({ title: c.title, active: c.active, completed: c.completed,
      earned: c.earned, claimed: c.claimed, pending: c.pending, total: c.total })),
    receipts: Object.values(handled).filter(d => d?.platform === 'twitch')
      .sort((a, b) => (b.receivedAt || b.handledAt || 0) - (a.receivedAt || a.handledAt || 0)).slice(0, 20).map(describe),
    cacheCheckedAt: cache.lastUpdated, pendingCards: cache.drops.filter(d => d.platform === 'twitch')
      .slice(0, 20).map(d => ({ ...describe(d), stale: d.stale === true })) };
}
