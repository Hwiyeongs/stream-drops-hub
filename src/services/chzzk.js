/**
 * Chzzk & Naver Game Drops Integration Service
 * Drops Inventory: https://game.naver.com/profile#drops
 * Fetches earned rewards from /drops/rewards/claims
 * Supports both In-App claimable rewards and Coupon Code rewards.
 */

import { fetchWithTimeout } from './fetch-helper.js';
import { parseExpTimestamp } from './storage.js';

const CHZZK_COMMERCIAL_API_V2 = 'https://api.chzzk.naver.com/commercial/v2';
const CHZZK_COMMERCIAL_API_V1 = 'https://api.chzzk.naver.com/commercial/v1';

const CHZZK_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Front-Client-Product-Type': 'GAME',
  'Front-Client-Platform-Type': 'PC',
};

export async function fetchChzzkDrops() {
  const drops = [];
  const now = new Date();

  try {
    // Fetch earned rewards, then apply claim and coupon expiry rules separately.
    const claimsRes = await fetchWithTimeout(
      `${CHZZK_COMMERCIAL_API_V2}/drops/rewards/claims`,
      {
        method: 'GET',
        credentials: 'include',
        headers: CHZZK_HEADERS,
      },
      8000
    );

    if (!claimsRes.ok) {
      const is401 = claimsRes.status === 401 || claimsRes.status === 403;
      return {
        loggedIn: is401 ? false : null,
        drops: [],
        error: is401 ? '치지직(네이버) 로그인이 필요합니다.' : '치지직 드롭스 조회 실패',
      };
    }

    const json = await claimsRes.json();
    if (!Array.isArray(json?.content?.claimList) || (json.code != null && json.code !== 200)) {
      throw new Error(json?.message || '치지직 보관함 응답 형식이 올바르지 않습니다.');
    }
    const claimList = json.content.claimList;

    const seenRewardNos = new Set();

    // 2. Process claims (최신 획득) - User has fulfilled condition
    for (const item of claimList) {
      const rewardNo = item.rewardNo || item.id;
      if (!rewardNo || seenRewardNos.has(rewardNo)) continue;

      // Determine if it is a coupon type
      const isCouponType = 
        item.rewardType === 'CODE_FIRST_COME' || 
        item.rewardType === 'CODE_LOTTERY' || 
        item.rewardType === 'COUPON' ||
        item.rewardType === 'CODE' ||
        item.rewardType === 'ITEM_CODE' ||
        item.rewardType?.includes?.('CODE') ||
        item.rewardType?.includes?.('COUPON') ||
        !!item.code || 
        !!item.couponCode || 
        !!item.rewardCode ||
        !!item.codeEndDate ||
        !!item.useEndDate ||
        !!item.useExpDate;

      // 1. Explicit status check
      if (item.isExpired === true || item.expired === true || item.status === 'EXPIRED' || item.state === 'EXPIRED' || item.fulfillmentState === 'EXPIRED') {
        continue;
      }

      // 2. Coupon code expiration check (쿠폰 자체 유효기간 만료 여부)
      const codeExpStr = item.codeEndDate || item.useEndDate || item.useExpDate || item.codeExpireDate || item.expireDate || item.usableEndDate;
      if (codeExpStr) {
        const codeExpTime = parseExpTimestamp(codeExpStr);
        if (codeExpTime !== null && codeExpTime < now.getTime()) {
          continue; // 이미 만료된 쿠폰
        }
      }

      // 3. Campaign claim end date check (신청 기한 만료 여부)
      const campClaimEndStr = item.campaign?.claimEndDate || item.claimExpiresAt;
      const alreadyIssued = item.fulfillmentState === 'REQUESTED' || item.fulfillmentState === 'COMPLETED' || item.isClaimed || item.code || item.couponCode || item.rewardCode;
      if (campClaimEndStr && !(isCouponType && alreadyIssued)) {
        const claimEndTime = parseExpTimestamp(campClaimEndStr);
        if (claimEndTime !== null && claimEndTime < now.getTime()) {
          continue; // 신청 기한 만료
        }
      }

      // Earned rewards remain available until their own deadline, regardless of acquisition day.
      // Campaign viewing end/state must not expire an already earned reward.

      const isClaimed = item.fulfillmentState === 'REQUESTED' || item.fulfillmentState === 'COMPLETED' || item.isClaimed;

      // 이미 수령 완료된 인앱 보상은 제외 (미신청 COMPLIED 상태이거나 쿠폰인 경우 표시)
      if (!isCouponType && isClaimed) {
        continue;
      }

      seenRewardNos.add(rewardNo);

      let couponCode = item.code || item.couponCode || item.rewardCode || item.coupon?.code || null;
// Coupon codes are fetched on demand, not serially during every inventory poll.

      const displayExpDate = isCouponType && alreadyIssued ? (codeExpStr || null) : (codeExpStr || campClaimEndStr || null);

      drops.push({
        id: `chzzk_${rewardNo}`,
        platform: 'chzzk',
        platformName: '치지직',
        gameTitle: item.categoryValue || item.campaign?.campaignName || '치지직 드롭스',
        campaignName: item.campaign?.campaignName || '드롭스 보상',
        rewardName: item.rewardName || '치지직 드롭스 보상',
        rewardImageUrl: item.imageUrl || null,
        status: 'CLAIMABLE',
        claimable: true,
        acquiredAt: item.createdDate || null,
        rewardNo: rewardNo,
        rewardType: item.rewardType || 'IN_APP',
        couponCode: couponCode,
        isCoupon: isCouponType || !!couponCode,
        campaignUrl: 'https://game.naver.com/profile#drops',
        expDate: displayExpDate,
      });
    }

    return {
      loggedIn: true,
      drops,
      error: null,
    };
  } catch (err) {
    console.error('[Chzzk] Drops fetch error:', err);
    return {
      loggedIn: null,
      drops: [],
      error: `치지직 데이터 조회 실패: ${err.message}`,
    };
  }
}

export async function fetchChzzkCouponCode(rewardNo) {
  try {
    const res = await fetchWithTimeout(
      `${CHZZK_COMMERCIAL_API_V1}/drops/rewards/${rewardNo}/coupon-code`,
      {
        method: 'GET',
        credentials: 'include',
        headers: CHZZK_HEADERS,
      },
      3000
    );

    if (res.ok) {
      const json = await res.json();
      const code = json?.content?.code;
      if (typeof code === 'string' && code.trim()) return code.trim();
    }
  } catch (err) {
    console.warn(`[Chzzk] Coupon code fetch failed for ${rewardNo}:`, err);
  }
  return null;
}

export async function claimChzzkDrop(rewardNo) {
  const res = await fetchWithTimeout(
    `${CHZZK_COMMERCIAL_API_V2}/drops/rewards/${rewardNo}/claim`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: {
        ...CHZZK_HEADERS,
        'Content-Type': 'application/json',
      },
    },
    8000
  );

  if (!res.ok) {
    throw new Error(`치지직 보상 수령 실패 (HTTP ${res.status})`);
  }

  const json = await res.json();
  if (json.code !== 200 && json.status !== 'success') {
    throw new Error(json.message || '수령 처리에 실패했습니다.');
  }

  return { success: true, message: '보상이 수령되었습니다.' };
}
