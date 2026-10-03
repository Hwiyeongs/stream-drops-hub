import { dropsDay } from './drops-day.js';
import { getCachedDrops, getHandledDropsLog, getHiddenDrops, parseTimestamp } from './storage.js';
import { isActiveDrop } from './aggregator.js';
import { isRewardVisible } from './reward-visibility.js';

const PLATFORMS = ['chzzk', 'soop', 'twitch'];
const validTime = (value, now) => Number.isFinite(value) && value > 0 && value <= now ? value : null;
const unique = entries => [...new Map(entries.map(entry => [entry.platform === 'twitch' && entry.dropInstanceId ?
  'twitch:' + (entry.twitchUserId || '') + ':' + entry.dropInstanceId : entry.id, entry])).values()];
/** Counts confirmed facts only; campaign dates are never acquisition timestamps. */
export function buildDailySummary({ cached = {}, handled = {}, hidden = {}, accounts = {}, lastSuccess = {}, collectorState = {}, now = Date.now() } = {}) {
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
    const acquired = unique([...(cached.drops || []).filter(entry => entry.platform === platform && isRewardVisible(entry, hidden)), ...processed]);
    const count = platform === 'twitch' ? currentAccount ? processed.filter(entry => entry.actionType === 'claimed' &&
      entry.twitchUserId && String(entry.twitchUserId) === String(currentAccount) && today(entry.claimedAt ??
        (entry.receiptIdentityVerified && !entry.claimStatus ? entry.receivedAt ?? entry.handledAt : null))).length : null :
      processed.filter(entry => ['saved', 'copied', 'claimed'].includes(entry.actionType) && today(entry.receivedAt ?? entry.handledAt)).length;
    platforms[platform] = {
      earnedToday: platform === 'chzzk' ? acquired.filter(entry => today(entry.acquiredAt)).length : null,
      processedToday: count,
      pending: unique(pending.filter(entry => entry.platform === platform)).length,
      state, lastSuccessAt: validTime(lastSuccess[platform], now) ?? (state === 'ok' ? validTime(cached.lastUpdated, now) : null),
    };
  }
  return { day, resetHourKst: 5, generatedAt: now, platforms };
}
export async function getDailySummary(now = Date.now()) {
  const [cached, handled, hidden, { inventoryAccounts = {}, inventoryLastSuccess = {}, collectorState = {} }] = await Promise.all([
    getCachedDrops(), getHandledDropsLog(), getHiddenDrops(), chrome.storage.local.get(['inventoryAccounts', 'inventoryLastSuccess', 'collectorState']),
  ]);
  return buildDailySummary({ cached, handled, hidden, accounts: inventoryAccounts, lastSuccess: inventoryLastSuccess, collectorState, now });
}