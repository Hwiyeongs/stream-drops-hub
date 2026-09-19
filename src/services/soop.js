/**
 * SOOP Drops Integration Service (Coupon Codes & Inventory)
 * Official Inventory Web: https://drops.sooplive.com/inventory
 */

import { fetchWithTimeout } from './fetch-helper.js';
import { getSavedCouponCodes, saveCouponCode, parseExpTimestamp, parseTimestamp, yesterdayStart } from './storage.js';

const SOOP_API_BASE = 'https://drops.sooplive.com/api';
const SOOP_INVENTORY_URL = 'https://drops.sooplive.com/inventory';

/**
 * Extracts a normalized date timestamp (e.g. from [09/06] or [2026-09-06])
 * to identify current vs past daily drop batches.
 */
export function parseItemDateValue(item, now = Date.now()) {
  const field = item.sendDate || item.regDate || item.registDate || item.createDate || item.date;
  const fieldTime = parseTimestamp(field);
  const text = [item.itemName, item.title].filter(Boolean).join(' ');
  const full = text.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  if (full) return parseTimestamp(full[1] + '-' + full[2] + '-' + full[3]);
  const short = text.match(/(?:\[|\()(\d{1,2})[./-](\d{1,2})(?:\]|\))/);
  if (short) {
    const year = new Date((fieldTime ?? now) + 9 * 3600000).getUTCFullYear();
    let result = parseTimestamp(year + '-' + short[1] + '-' + short[2]);
    // Around New Year, a December reward belongs to the previous year.
    if (fieldTime === null && result !== null && result > now + 86400000) result = parseTimestamp((year - 1) + '-' + short[1] + '-' + short[2]);
    return result;
  }
  return fieldTime;
}

export async function fetchSoopDrops() {
  try {
    // 1. Fetch both 'available' (신규 대기) and 'acquired' (발급완료/유효기간내) in parallel
    const [availRes, acqRes] = await Promise.allSettled([
      fetchWithTimeout(
        `${SOOP_API_BASE}/get_drops_list.php`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
          },
          body: JSON.stringify({
            pageNo: 1,
            prePageNo: 30,
            division: 'available',
          }),
        },
        5000
      ),
      fetchWithTimeout(
        `${SOOP_API_BASE}/get_drops_list.php`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
          },
          body: JSON.stringify({
            pageNo: 1,
            prePageNo: 30,
            division: 'acquired',
          }),
        },
        5000
      ),
    ]);

    // Check login status
    const isAvail401 = availRes.status === 'fulfilled' && (availRes.value.status === 401 || availRes.value.status === 403);
    const isAcq401 = acqRes.status === 'fulfilled' && (acqRes.value.status === 401 || acqRes.value.status === 403);
    if (isAvail401 || isAcq401) {
      return {
        loggedIn: false,
        drops: [],
        error: 'SOOP 로그인이 필요합니다.',
      };
    }

    const allItems = [];

    const errors = [];
    let validResponses = 0;
    for (const [result, division] of [[availRes, 'available'], [acqRes, 'acquired']]) {
      try {
        if (result.status !== 'fulfilled') throw new Error('연결 시간 초과');
        if (!result.value.ok) throw new Error('HTTP ' + result.value.status);
        const json = await result.value.json();
        if (!Array.isArray(json?.data)) throw new Error(json?.message || '보관함 응답 형식 오류');
        validResponses++;
        allItems.push(...json.data.map(item => ({ ...item, _sourceDivision: division })));
      } catch (error) { errors.push(division + ': ' + error.message); }
    }
    if (!validResponses) return { loggedIn: null, drops: [], error: 'SOOP 조회 실패: ' + errors.join(' / ') };

    const savedCodes = await getSavedCouponCodes();
    const drops = [];
    const now = new Date();
    const seenItemCodeIdxs = new Set();

    // Group items by category/game for smart active-round date detection
    const groups = new Map();
    for (const item of allItems) {
      const cat = item.cateName || item.category || 'default';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(item);
    }

    for (const [cat, groupItems] of groups.entries()) {
      for (const item of groupItems) {
        const idx = item.itemCodeIdx;
        if (!idx || seenItemCodeIdxs.has(idx)) continue;

        // Check if expired:
        let isExpired = item.isExpired === true;
        const expStr = item.useExpDate || item.expDate;
        if (expStr) {
          const expTime = parseExpTimestamp(expStr);
          if (expTime !== null && expTime < now.getTime()) {
            isExpired = true;
          }
        }

        // Skip expired items
        if (isExpired) {
          continue;
        }

        const itemDate = parseItemDateValue(item, now.getTime());
        if (itemDate !== null && (itemDate < yesterdayStart(now.getTime()) || itemDate > now.getTime())) continue;

        seenItemCodeIdxs.add(idx);

        // Check if code was already saved in local storage or returned in list
        const couponCode = item.itemCode || savedCodes[String(idx)] || null;

        drops.push({
          id: `soop_inv_${idx}`,
          platform: 'soop',
          platformName: 'SOOP',
          gameTitle: item.cateName || item.title || 'SOOP 드롭스',
          campaignName: item.title || '드롭스 보상',
          rewardName: item.itemName || '드롭스 리워드',
          rewardImageUrl: item.image || null,
          status: 'CLAIMABLE',
          claimable: true,
          couponCode: couponCode,
          itemCodeIdx: idx,
          isCoupon: true,
          campaignUrl: SOOP_INVENTORY_URL,
          expDate: item.useExpDate || item.expDate || null,
          recentDate: itemDate === null ? null : new Date(itemDate).toISOString(),
        });
      }
    }

    return {
      loggedIn: true,
      drops,
      error: errors.length ? 'SOOP 일부 조회 실패: ' + errors.join(' / ') : null,
    };
  } catch (err) {
    console.warn('[SOOP] Fetch error:', err);
    return {
      loggedIn: null,
      drops: [],
      error: err.message,
    };
  }
}

export async function claimSoopDrop(itemCodeIdx) {
  const res = await fetchWithTimeout(
    `${SOOP_API_BASE}/get_drops_use_info.php`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ itemCodeIdx }),
    },
    5000
  );

  if (!res.ok) {
    throw new Error(`SOOP 보상 확인 실패 (HTTP ${res.status})`);
  }

  const json = await res.json();
  const itemCode = json.data?.itemCode || json.data?.code;
  if (typeof itemCode !== 'string' || !itemCode.trim()) throw new Error(json.message || 'SOOP 쿠폰 코드를 확인하지 못했습니다. 다시 시도해 주세요.');
  await saveCouponCode(itemCodeIdx, itemCode);
  return { success: true, itemCode: itemCode.trim(), message: '쿠폰 코드 보관 완료' };
}
