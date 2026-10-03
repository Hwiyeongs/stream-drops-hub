import { dropsDay } from './drops-day.js';
import { acquisitionRecords } from './reward-acquisition.js';
import { getCachedDrops, getHandledDropsLog, getHiddenDrops, parseTimestamp } from './storage.js';
import { isActiveDrop } from './aggregator.js';
import { isRewardVisible } from './reward-visibility.js';

const PLATFORMS = ['chzzk', 'soop', 'twitch'];
const validTime = (value, now) => Number.isFinite(value) && value > 0 && value <= now ? value : null;
const unique = entries => [...new Map(entries.map(entry => [entry.platform === 'twitch' && entry.dropInstanceId ?
  'twitch:' + (entry.twitchUserId || '') + ':' + entry.dropInstanceId : entry.id, entry])).values()];
/** Counts confirmed facts only; campaign dates are never acquisition timestamps. */
export function buildDailySummary({ cached = {}, handled = {}, hidden = {}, accounts = {}, lastSuccess = {}, collectorState = {}, acquisitions = [], now = Date.now() } = {}) {
  const day = dropsDay(now);
  const today = value => { const at = parseTimestamp(value); return at !== null && at <= now && dropsDay(at) === day; };
  const twitchStatus = cached.platformStatuses?.twitch;
  const viewerState = collectorState.twitch || {};
  const verifiedCollector = !viewerState.error && Number.isFinite(viewerState.campaignsCheckedAt) &&
    viewerState.campaignsCheckedAt <= now && now - viewerState.campaignsCheckedAt <= 3 * 60000;
  const currentAccount = twitchStatus?.loggedIn === false ? null :
    (twitchStatus?.loggedIn === true ? accounts.twitch : null) || (verifiedCollector ? viewerState.twitchUserId : null) || null;
  const receipts = Object.values(handled).filter(entry => entry && isRewardVisible(entry, hidden));
  const pending = (cached.drops || []).filter(entry => isActiveDrop(entry, handled, now) && isRewardVisible(entry, hidden));
  const platforms = {};
  for (const platform of PLATFORMS) {
    const status = cached.platformStatuses?.[platform];
    const state = !status ? 'unknown' : status.loggedIn === false ? 'login' : status.error || status.stale ? 'stale' : status.loggedIn === true ? 'ok' : 'unknown';
    const processed = unique(receipts.filter(entry => entry.platform === platform));
    const candidates = [...processed, ...acquisitions, ...(cached.drops || [])].filter(entry => entry?.platform === platform &&
      isRewardVisible(entry, hidden) && (platform !== 'twitch' || currentAccount && String(entry.twitchUserId || '') === String(currentAccount)));
    const acquiredById = new Map();
    for (const entry of candidates) {
      const identity = platform === 'twitch' ? JSON.stringify([entry.twitchUserId, entry.campaignId || '', entry.timeBasedDropId || entry.dropInstanceId || entry.id]) : entry.id;
      const previous = acquiredById.get(identity);
      if (!previous || parseTimestamp(entry.acquiredAt) !== null) acquiredById.set(identity, entry);
    }
    const acquired = [...acquiredById.values()];
    const earnedCount = acquired.filter(entry => today(entry.acquiredAt)).length;
    const undated = acquired.some(entry => parseTimestamp(entry.acquiredAt) === null);
    const count = platform === 'twitch' ? currentAccount ? processed.filter(entry => entry.actionType === 'claimed' &&
      entry.twitchUserId && String(entry.twitchUserId) === String(currentAccount) && today(entry.claimedAt ??
        (entry.receiptIdentityVerified && !entry.claimStatus ? entry.receivedAt ?? entry.handledAt : null))).length : null :
      processed.filter(entry => ['saved', 'copied', 'claimed'].includes(entry.actionType) && today(entry.receivedAt ?? entry.handledAt)).length;
    platforms[platform] = {
      earnedToday: platform === 'twitch' && !currentAccount || !earnedCount && undated ? null : earnedCount,
      processedToday: count,
      pending: unique(pending.filter(entry => entry.platform === platform)).length,
      state, lastSuccessAt: validTime(lastSuccess[platform], now) ?? (state === 'ok' ? validTime(cached.lastUpdated, now) : null),
    };
  }
  return { day, resetHourKst: 5, generatedAt: now, platforms };
}
export async function getDailySummary(now = Date.now()) {
  const [cached, handled, hidden, stored] = await Promise.all([
    getCachedDrops(), getHandledDropsLog(), getHiddenDrops(), chrome.storage.local.get(null),
  ]);
  const { inventoryAccounts = {}, inventoryLastSuccess = {}, collectorState = {} } = stored;
  return buildDailySummary({ cached, handled, hidden, accounts: inventoryAccounts, lastSuccess: inventoryLastSuccess,
    collectorState, acquisitions: acquisitionRecords(stored), now });
}
