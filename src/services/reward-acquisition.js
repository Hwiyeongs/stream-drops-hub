import { dropsDay } from './drops-day.js';
const PREFIX = 'earned:twitch:';
let tail = Promise.resolve();
/** Observe server progress, never the later claim action. An initial completed snapshot has no known acquisition day. */
export function observeTwitchAcquisitions(campaigns, account, now = Date.now()) {
  const task = tail.then(async () => {
    if (!account || !Number.isFinite(now) || now <= 0) return campaigns;
    const stored = await chrome.storage.local.get(null), updates = {};
    const receipts = new Map(Object.entries(stored).filter(([key, entry]) => key.startsWith('handled:') &&
      entry?.platform === 'twitch' && entry.actionType === 'claimed' && String(entry.twitchUserId || '') === String(account) &&
      entry.campaignId && entry.timeBasedDropId).map(([, entry]) => [JSON.stringify([String(entry.campaignId), String(entry.timeBasedDropId)]), entry]));
    const result = campaigns.map(campaign => ({ ...campaign, timeBasedDrops: (campaign.timeBasedDrops || []).map(drop => {
      if (!campaign.id || !drop.id) return drop;
      const self = drop.self;
      const required = Number(drop.requiredMinutesWatched), watched = self?.currentMinutesWatched;
      const known = self?.isClaimed === true || (self && Number.isFinite(watched) && watched >= 0 && Number.isFinite(required) && required > 0);
      const key = PREFIX + JSON.stringify([String(account), String(campaign.id), String(drop.id)]);
      const old = stored[key];
      const receipt = receipts.get(JSON.stringify([String(campaign.id), String(drop.id)]));
      const instance = self?.dropInstanceID ? String(self.dropInstanceID) : old?.dropInstanceId || receipt?.dropInstanceId || null;
      const knownReceipt = receipt && (!instance || !receipt.dropInstanceId || instance === receipt.dropInstanceId) ? receipt : null;
      const sameInstance = !old?.dropInstanceId || !instance || old.dropInstanceId === instance;
      const previous = sameInstance ? old : null;
      let acquiredAt = previous?.acquiredAt ?? knownReceipt?.acquiredAt ?? null;
      if (known) {
        const earned = !!knownReceipt || self.isClaimed === true || watched >= required;
        if (!acquiredAt && !knownReceipt && earned && previous?.earned === false && Number.isFinite(previous.checkedAt) && previous.checkedAt > 0 && previous.checkedAt <= now &&
          dropsDay(previous.checkedAt) === dropsDay(now)) acquiredAt = now;
        const record = { id: instance ? 'twitch_' + instance : null, platform: 'twitch', twitchUserId: String(account),
          campaignId: String(campaign.id), timeBasedDropId: String(drop.id), dropInstanceId: instance,
          acquiredAt, acquisitionSource: acquiredAt ? 'observed' : null, earned: !!(previous?.earned || earned), checkedAt: now };
        updates[key] = record;
      }
      return { ...drop, acquiredAt, acquisitionSource: acquiredAt ? 'observed' : null };
    }) }));
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    return result;
  });
  tail = task.catch(() => {});
  return task;
}
export function acquisitionRecords(stored) {
  return Object.entries(stored).filter(([key]) => key.startsWith(PREFIX)).map(([, entry]) => entry).filter(entry => entry?.earned === true);
}
