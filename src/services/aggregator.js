import { fetchTwitchDrops, claimTwitchDrop } from './twitch.js';
import { fetchChzzkDrops, claimChzzkDrop, fetchChzzkCouponCode } from './chzzk.js';
import { fetchSoopDrops, claimSoopDrop } from './soop.js';
import { saveCachedDrops, getCachedDrops, getHandledDropsLog, recordHandledDrop, parseExpTimestamp, isRecentDate } from './storage.js';

export function isActiveDrop(drop, handled = {}, now = Date.now()) {
  if (!drop?.claimable || handled[drop.id]) return false;
  const expiry = parseExpTimestamp(drop.expDate);
  if (expiry !== null && expiry < now) return false;
  if (drop.platform === 'soop' && drop.recentDate && !isRecentDate(drop.recentDate, now)) return false;
  return true;
}
export async function fetchAllDrops() {
  const previous = await getCachedDrops();
  const results = await Promise.allSettled([fetchTwitchDrops(), fetchChzzkDrops(), fetchSoopDrops()]);
  const names = ['twitch', 'chzzk', 'soop'];
  const statuses = {}, drops = [];
  results.forEach((result, index) => {
    const platform = names[index];
    const value = result.status === 'fulfilled' ? result.value : { loggedIn: null, drops: [], error: result.reason?.message || '연결 오류' };
    statuses[platform] = { loggedIn: value.loggedIn, error: value.error || null, stale: !!value.error };
    if (value.error && value.loggedIn !== false) {
      // Keep last-known cards visible, but claims must wait for a successful refresh.
      const merged = new Map(previous.drops.filter(d => d.platform === platform).map(d => [d.id, d]));
      for (const drop of value.drops || []) merged.set(drop.id, drop);
      drops.push(...Array.from(merged.values(), d => ({ ...d, stale: true })));
    } else {
      drops.push(...(value.drops || []).map(d => ({ ...d, stale: false })));
    }
  });
  const handled = await getHandledDropsLog();
  const active = drops.filter(d => isActiveDrop(d, handled));
  const cache = await saveCachedDrops(active, statuses);
  return { ...cache, totalCount: active.length, claimableCount: active.filter(d => !d.stale).length };
}

export async function claimUnifiedDrop(drop) {
  const handled = (await getHandledDropsLog())[drop.id];
  if (handled) return { success: true, itemCode: handled.couponCode, alreadyHandled: true };
  if (!isActiveDrop(drop)) throw new Error('현재 수령할 수 없는 보상입니다. 새로고침해 주세요.');
  if (drop.stale) throw new Error('최신 목록 조회에 실패했습니다. 새로고침 후 수령해 주세요.');
  let result;
  if (drop.isCoupon || drop.couponCode || drop.platform === 'soop') {
    let code = drop.couponCode;
    if (!code) {
      if (drop.platform === 'chzzk') code = await fetchChzzkCouponCode(drop.rewardNo);
      else if (drop.platform === 'soop') code = (await claimSoopDrop(drop.itemCodeIdx)).itemCode;
      else throw new Error('지원하지 않는 쿠폰 플랫폼입니다.');
    }
    if (typeof code !== 'string' || !code.trim()) throw new Error('쿠폰 코드를 확인하지 못했습니다. 다시 시도해 주세요.');
    result = { success: true, itemCode: code.trim() };
    await recordHandledDrop({ ...drop, couponCode: code.trim() }, 'saved');
  } else {
    if (drop.platform === 'twitch') result = await claimTwitchDrop(drop.dropInstanceId, drop.twitchUserId);
    else if (drop.platform === 'chzzk') result = await claimChzzkDrop(drop.rewardNo);
    else throw new Error('지원하지 않는 플랫폼입니다.');
    if (result?.success !== true) throw new Error('수령 완료를 확인하지 못했습니다.');
    const receipt = drop.platform === 'twitch' ? { ...drop,
      twitchUserId: result.twitchUserId, twitchUserLogin: result.twitchUserLogin,
      claimStatus: result.status, claimedAt: result.claimedAt,
      claimConfirmedAt: result.claimConfirmedAt } : drop;
    await recordHandledDrop(receipt, 'claimed');
  }
  // Remove only the confirmed item. Other failures remain visible and retryable.
  const cache = await getCachedDrops();
  await chrome.storage.local.set({ dropsCache: cache.drops.filter(d => d.id !== drop.id) });
  return result;
}
