import { twitchDisplayDate } from './campaign-date.js';
/**
 * Twitch Drops Integration Service (Pending Claims Only)
 * Official Inventory Web: https://www.twitch.tv/drops/inventory
 * Only displays drops that are currently claimable (not already acquired, not expired).
 */

import { fetchWithTimeout } from './fetch-helper.js';
import { parseExpTimestamp } from './storage.js';
import { buildCapturedTwitchRequestHeaders, clearCapturedTwitchGqlHeaders, getCapturedTwitchGqlHeaders, waitForCapturedTwitchGqlHeaders } from './twitch-headers.js';

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Twitch official GQL persisted query hash for Inventory
const INVENTORY_QUERY_HASH = '8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404';


function cleanToken(token) {
  if (!token) return null;
  let t = decodeURIComponent(token).trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1);
  }
  return t;
}


export async function getTwitchAuthToken() {
  try {
    // 1. Try https://www.twitch.tv
    let cookie = await chrome.cookies.get({
      url: 'https://www.twitch.tv',
      name: 'auth-token',
    });
    if (cookie && cookie.value) {
      return cleanToken(cookie.value);
    }

    // 2. Try https://twitch.tv
    cookie = await chrome.cookies.get({
      url: 'https://twitch.tv',
      name: 'auth-token',
    });
    if (cookie && cookie.value) {
      return cleanToken(cookie.value);
    }

    // 3. Try https://passport.twitch.tv
    cookie = await chrome.cookies.get({
      url: 'https://passport.twitch.tv',
      name: 'auth-token',
    });
    if (cookie && cookie.value) {
      return cleanToken(cookie.value);
    }

    // 4. Search all cookies for domain twitch.tv
    const allCookies = await chrome.cookies.getAll({
      name: 'auth-token',
    });
    const match = allCookies.find((c) => c.domain && c.domain.includes('twitch.tv'));
    if (match && match.value) {
      return cleanToken(match.value);
    }

    return null;
  } catch (err) {
    console.warn('[Twitch] Failed to get auth-token cookie:', err);
    return null;
  }
}

export function decodeInventoryResponse(json) {
  // A batch envelope is allowed only when it contains this single operation.
  if (Array.isArray(json)) json = json.length === 1 ? json[0] : null;
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const relevantErrors = errors.filter(error => {
    const path = error.path;
    if (!Array.isArray(path) || !path.length) return true;
    return path[0] === 'currentUser' && (path.length === 1 ||
      (path[1] === 'inventory' && (path.length === 2 || path[2] === 'dropCampaignsInProgress')));
  });
  if (relevantErrors.length) return { loggedIn: null, error: `트위치 조회 실패: ${relevantErrors[0].message || '서버 오류'}`, retry: true };
  if (json?.data?.currentUser === null) return { loggedIn: false, error: '트위치 세션이 만료되었거나 로그인이 필요합니다.', retry: false };
  const inventory = json?.data?.currentUser?.inventory;
  if (!inventory || !Object.hasOwn(inventory, 'dropCampaignsInProgress')) {
    return { loggedIn: null, error: '트위치 응답에 보관함 목록이 없습니다. 다시 조회해 주세요.', retry: true };
  }
  const campaigns = inventory.dropCampaignsInProgress;
  // No active campaigns may be encoded as null. Do not confuse it with a missing field or a GQL failure.
  if (campaigns !== null && !Array.isArray(campaigns)) return { loggedIn: true, error: '트위치 보관함 목록을 해석할 수 없습니다.', retry: true };
  return { loggedIn: true, campaigns: campaigns || [], error: null, retry: false };
}

export async function fetchTwitchDrops() {
  const authToken = await getTwitchAuthToken();
  if (!authToken) {
    return {
      loggedIn: false,
      drops: [],
      error: '트위치 로그인이 필요합니다.',
    };
  }

  let json = null;

  // 1. Primary approach: Official persisted query (high performance, lowest bandwidth)
  try {
    const res = await fetchWithTimeout(
      TWITCH_GQL_URL,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Client-Id': TWITCH_CLIENT_ID,
          'Authorization': `OAuth ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operationName: 'Inventory',
          extensions: {
            persistedQuery: {
              version: 1,
              sha256Hash: INVENTORY_QUERY_HASH,
            },
          },
          variables: {
            fetchRewardCampaigns: false,
          },
        }),
      },
      8000
    );

    if (res.ok) {
      const data = await res.json();
      if (!data.errors || !data.errors.some((e) => e.message && e.message.includes('PersistedQueryNotFound'))) {
        json = data;
      }
    }
  } catch (e) {
    console.warn('[Twitch] Persisted query failed, falling back to raw GQL:', e);
  }

  // 2. Fallback approach: Valid raw GraphQL query conforming to Twitch schema
  if (decodeInventoryResponse(json).retry) {
    const rawQuery = `
      query Inventory {
        currentUser {
          id
          inventory {
            dropCampaignsInProgress {
              id
              name
              status
              startAt
              endAt
              game {
                id
                displayName
                boxArtURL
              }
              timeBasedDrops {
                id
                name
                startAt
                endAt
                requiredMinutesWatched
                benefitEdges {
                  benefit {
                    id
                    name
                    imageAssetURL
                  }
                }
                self {
                  currentMinutesWatched
                  isClaimed
                  dropInstanceID
                }
              }
            }
          }
        }
      }
    `;

    try {
      const res = await fetchWithTimeout(
        TWITCH_GQL_URL,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Client-Id': TWITCH_CLIENT_ID,
            'Authorization': `OAuth ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            operationName: 'Inventory',
            query: rawQuery,
          }),
        },
        8000
      );

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      json = await res.json();
    } catch (err) {
      console.error('[Twitch] Drops fetch error:', err);
      return {
        loggedIn: null,
        drops: [],
        error: `트위치 데이터 조회 실패: ${err.message}`,
      };
    }
  }

  const decoded = decodeInventoryResponse(json);
  if (decoded.error) return { loggedIn: decoded.loggedIn, drops: [], error: decoded.error };
  const campaigns = decoded.campaigns;
  const now = new Date();
  const drops = [];

  for (const campaign of campaigns) {
    // Use explicit claim deadline when supplied; do not invent a 24-hour grace period.
    const deadline = campaign.claimEndAt || campaign.endAt || null;
    const expires = parseExpTimestamp(deadline);
    if (expires !== null && expires < now.getTime()) continue;

    const gameTitle = campaign.game?.displayName || '트위치 드롭스';
    const boxArt = campaign.game?.boxArtURL
      ? campaign.game.boxArtURL.replace('{width}', '100').replace('{height}', '133')
      : null;

    for (const timeDrop of campaign.timeBasedDrops || []) {
      const selfContext = timeDrop.self || {};

      // 1. 이미 획득 완료된 항목 제외!
      if (selfContext.isClaimed === true) {
        continue;
      }

      const reqMin = timeDrop.requiredMinutesWatched || 1;
      const curMin = selfContext.currentMinutesWatched || 0;

      // An exact instance ID and the full watch duration are both required.
      const hasClaimId = !!selfContext.dropInstanceID;
      const isCompleted = curMin >= reqMin;
      const claimable = hasClaimId && isCompleted;

      // 아직 진행 중(시청 시간 100% 미달)인 항목 제외!
      if (!claimable) {
        continue;
      }

      const benefit = timeDrop.benefitEdges?.[0]?.benefit;
      const rewardName = benefit?.name || timeDrop.name || 'Drops 보상';
      const rewardImageUrl = benefit?.imageAssetURL || boxArt;

      drops.push({
        id: `twitch_${selfContext.dropInstanceID}`,
        platform: 'twitch',
        platformName: '트위치',
        gameTitle,
        campaignName: campaign.name,
        campaignDate: twitchDisplayDate(campaign.name, timeDrop.startAt, campaign.startAt, campaign.endAt),
        rewardName,
        rewardImageUrl,
        status: 'CLAIMABLE',
        claimable: true,
        dropInstanceId: selfContext.dropInstanceID || null,
        campaignUrl: 'https://www.twitch.tv/drops/inventory',
        expDate: deadline,
      });
    }
  }

  return {
    loggedIn: true,
    drops,
    error: null,
  };
}

async function ensureTwitchClaimHeaders({ forceFresh = false } = {}) {
  if (forceFresh) await clearCapturedTwitchGqlHeaders();
  else {
    const existing = await getCapturedTwitchGqlHeaders();
    if (existing) return { capture: existing, temporaryTabId: null };
  }

  const startedAt = Date.now();
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: '*://*.twitch.tv/*' }); } catch {}

  // Give an already-open Twitch page a moment to emit one of its normal GQL requests.
  if (!forceFresh && tabs.length) {
    const passive = await waitForCapturedTwitchGqlHeaders({ newerThan: startedAt - 1, timeoutMs: 2000 });
    if (passive) return { capture: passive, temporaryTabId: null };
  }

  let inventoryTab = tabs.find(tab => tab?.url?.includes('/drops/inventory')) || null;
  let temporaryTabId = null;
  let captureStart = Date.now();

  if (!inventoryTab?.id && chrome.tabs?.create) {
    inventoryTab = await chrome.tabs.create({ url: 'https://www.twitch.tv/drops/inventory', active: false });
    temporaryTabId = inventoryTab?.id ?? null;
    if (temporaryTabId && chrome.tabs.update) {
      try { await chrome.tabs.update(temporaryTabId, { autoDiscardable: false }); } catch {}
    }
  } else if (inventoryTab?.id && chrome.tabs?.reload) {
    try { await chrome.tabs.reload(inventoryTab.id); } catch {}
  }

  let capture = await waitForCapturedTwitchGqlHeaders({ newerThan: captureStart - 1, timeoutMs: 15000 });
  if (!capture && inventoryTab?.id && chrome.tabs?.reload) {
    captureStart = Date.now();
    try { await chrome.tabs.reload(inventoryTab.id); } catch {}
    capture = await waitForCapturedTwitchGqlHeaders({ newerThan: captureStart - 1, timeoutMs: 12000 });
  }

  if (!capture) {
    if (temporaryTabId && chrome.tabs?.remove) {
      try { await chrome.tabs.remove(temporaryTabId); } catch {}
    }
    throw new Error('트위치 페이지의 보안 헤더를 가져오지 못했습니다. 트위치 보관함이 정상 로드된 상태에서 다시 시도해 주세요.');
  }
  return { capture, temporaryTabId };
}

async function sendCapturedTwitchClaim(dropInstanceId, capture) {
  const query = `
    mutation DropsPage_ClaimDropRewards($input: ClaimDropRewardsInput!) {
      claimDropRewards(input: $input) { status }
    }
  `;
  const response = await fetchWithTimeout(
    TWITCH_GQL_URL,
    {
      method: 'POST',
      headers: buildCapturedTwitchRequestHeaders(capture),
      body: JSON.stringify({
        operationName: 'DropsPage_ClaimDropRewards',
        query,
        variables: { input: { dropInstanceID: dropInstanceId } },
      }),
    },
    8000
  );
  let json = null;
  try { json = await response.json(); } catch {}
  return { response, json };
}

// Claim exact instances only. The integrity/session headers are borrowed from Twitch's own page request.
export async function claimTwitchDrop(dropInstanceId) {
  if (typeof dropInstanceId !== 'string' || !dropInstanceId.trim()) {
    throw new Error('수령 가능한 보상 ID가 없습니다. 보관함을 새로고침해 주세요.');
  }

  const temporaryTabs = new Set();
  try {
    let session = await ensureTwitchClaimHeaders();
    if (session.temporaryTabId) temporaryTabs.add(session.temporaryTabId);
    let { response, json } = await sendCapturedTwitchClaim(dropInstanceId, session.capture);

    const hasIntegrityError = payload => payload?.errors?.some(error => /integrity/i.test(error?.message || ''));
    if (hasIntegrityError(json)) {
      // The page renews Client-Integrity itself. Force a newly observed page request and retry once.
      session = await ensureTwitchClaimHeaders({ forceFresh: true });
      if (session.temporaryTabId) temporaryTabs.add(session.temporaryTabId);
      ({ response, json } = await sendCapturedTwitchClaim(dropInstanceId, session.capture));
    }

    if (!response.ok) throw new Error(`수령 요청 실패 (HTTP ${response.status})`);
    if (json?.errors?.length) {
      const message = json.errors.map(error => error?.message || '수령 요청 실패').join(' | ');
      throw new Error(/integrity/i.test(message)
        ? `트위치 보안 토큰을 새로 가져왔지만 서버가 거부했습니다: ${message}`
        : message);
    }

    const claimStatus = json?.data?.claimDropRewards?.status;
    if (['ELIGIBLE_FOR_ALL', 'DROP_INSTANCE_ALREADY_CLAIMED', 'SUCCESS'].includes(claimStatus)) {
      return { success: true, status: claimStatus };
    }
    throw new Error(`트위치 수령을 확인하지 못했습니다 (${claimStatus || '응답 없음'}). 보관함에서 확인해 주세요.`);
  } finally {
    for (const tabId of temporaryTabs) {
      if (!chrome.tabs?.remove) continue;
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }
}
