import { campaignDisplayDate } from './campaign-date.js';
/**
 * Twitch Drops Integration Service (Pending Claims Only)
 * Official Inventory Web: https://www.twitch.tv/drops/inventory
 * Only displays drops that are currently claimable (not already acquired, not expired).
 */

import { fetchWithTimeout } from './fetch-helper.js';
import { parseExpTimestamp } from './storage.js';

const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Twitch official GQL persisted query hash for Inventory
const INVENTORY_QUERY_HASH = '8337eb8541b314040b0edde0c09c5c7a2783ba1960aa9edfbf3bac16d0fec404';

// Twitch official GQL persisted query hashes for ClaimDrop
const CLAIM_DROP_QUERY_HASH = '2f884fa187b8fadb2a49db0adc033e636f7b6aaee6e76de1e2bba9a7baf0daf6';
const CLAIM_DROP_QUERY_HASH_FALLBACK = 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930';

let cachedIntegrityToken = null;
let integrityTokenExpiry = 0;

function cleanToken(token) {
  if (!token) return null;
  let t = decodeURIComponent(token).trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1);
  }
  return t;
}

export async function getTwitchDeviceId() {
  try {
    const urls = ['https://www.twitch.tv', 'https://twitch.tv', 'https://passport.twitch.tv'];
    for (const u of urls) {
      const cookie = await chrome.cookies.get({ url: u, name: 'unique_id' });
      if (cookie?.value) return cleanToken(cookie.value);
    }
    const all = await chrome.cookies.getAll({ name: 'unique_id' });
    const match = all.find((c) => c.domain && c.domain.includes('twitch.tv'));
    if (match?.value) return cleanToken(match.value);
  } catch (err) {
    console.warn('[Twitch] Failed to get unique_id cookie:', err);
  }
  return null;
}

export async function getTwitchIntegrityToken(authToken, deviceId) {
  const now = Date.now();
  if (cachedIntegrityToken && integrityTokenExpiry > now + 60000) {
    return cachedIntegrityToken;
  }

  try {
    const headers = {
      'Client-Id': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `OAuth ${authToken}`;
    }
    if (deviceId) {
      headers['X-Device-Id'] = deviceId;
    }

    const res = await fetchWithTimeout(
      'https://gql.twitch.tv/integrity',
      {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({}),
      },
      6000
    );

    if (res.ok) {
      const data = await res.json();
      if (data?.token) {
        cachedIntegrityToken = data.token;
        integrityTokenExpiry = data.expiration || now + 12 * 60 * 60 * 1000;
        return cachedIntegrityToken;
      }
    }
  } catch (err) {
    console.warn('[Twitch] Failed to acquire integrity token:', err);
  }

  return null;
}

/** Send the selected instance ID from an existing Twitch page. */
async function tryClaimViaTwitchTab(dropInstanceId, authToken) {
  try {
    if (!chrome.tabs || !chrome.scripting) return null;
    const tabs = await chrome.tabs.query({ url: '*://*.twitch.tv/*' });
    if (!tabs || tabs.length === 0) return null;

    const targetTab = tabs.find((t) => t.url && new URL(t.url).hostname === 'www.twitch.tv');
    if (!targetTab?.id) return null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      world: 'MAIN',
      func: async (instanceId, passedToken) => {
        try {
          if (!passedToken) return { success: false, error: 'No auth-token' };

          // Execute the exact-ID mutation in the authenticated page context.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          let json;
          try {
          const res = await window.fetch('https://gql.twitch.tv/gql', {
            method: 'POST',
            signal: controller.signal,
            credentials: 'include',
            headers: {
              'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
              'Authorization': `OAuth ${passedToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              operationName: 'DropsPage_ClaimDropRewards',
              query: `mutation DropsPage_ClaimDropRewards($input: ClaimDropRewardsInput!) {
                claimDropRewards(input: $input) {
                  status
                }
              }`,
              variables: {
                input: {
                  dropInstanceID: instanceId,
                },
              },
            }),
          });

          if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
          json = await res.json();
          } finally { clearTimeout(timer); }
          if (json?.errors?.length) return { success: false, error: json.errors[0].message };
          const status = json?.data?.claimDropRewards?.status;
          if (
            status === 'ELIGIBLE_FOR_ALL' ||
            status === 'DROP_INSTANCE_ALREADY_CLAIMED' ||
            status === 'SUCCESS'
          ) {
            return { success: true, status };
          }
          return { success: false, error: 'Unknown response' };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [dropInstanceId, authToken],
    });

    const execResult = results?.[0]?.result;
    if (execResult && execResult.success) {
      return { success: true, status: execResult.status };
    }
  } catch (err) {
    console.warn('[Twitch] In-tab claim attempt failed:', err);
  }
  return null;
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
              endAt
              game {
                id
                displayName
                boxArtURL
              }
              timeBasedDrops {
                id
                name
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
        campaignDate: campaignDisplayDate(campaign.name, campaign.endAt),
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

// Claim exact instances only. No DOM guessing or unsolicited inventory clicks.
export async function claimTwitchDrop(dropInstanceId) {
  if (typeof dropInstanceId !== 'string' || !dropInstanceId.trim()) throw new Error('수령 가능한 보상 ID가 없습니다. 보관함을 새로고침해 주세요.');
  const authToken = await getTwitchAuthToken();
  if (!authToken) throw new Error('트위치 로그인이 필요합니다.');
  const tabClaim = await tryClaimViaTwitchTab(dropInstanceId, authToken);
  if (tabClaim?.success) return tabClaim;
  // =========================================================================
  // Direct API fallback with the current device/session context
  // =========================================================================
  const deviceId = await getTwitchDeviceId();
  let integrityToken = await getTwitchIntegrityToken(authToken, deviceId);

  const baseHeaders = {
    'Client-Id': TWITCH_CLIENT_ID,
    'Authorization': `OAuth ${authToken}`,
    'Content-Type': 'application/json',
  };
  if (deviceId) {
    baseHeaders['X-Device-Id'] = deviceId;
  }
  if (integrityToken) {
    baseHeaders['Client-Integrity'] = integrityToken;
  }

  async function sendClaimGQL(hash, rawQuery = null) {
    const payload = {
      operationName: 'DropsPage_ClaimDropRewards',
      variables: {
        input: {
          dropInstanceID: dropInstanceId,
        },
      },
    };
    if (rawQuery) {
      payload.query = rawQuery;
    } else {
      payload.extensions = {
        persistedQuery: {
          version: 1,
          sha256Hash: hash,
        },
      };
    }

    return await fetchWithTimeout(
      TWITCH_GQL_URL,
      {
        method: 'POST',
        credentials: 'include',
        headers: baseHeaders,
        body: JSON.stringify(payload),
      },
      8000
    );
  }

  // Attempt A: latest persisted query hash with integrity token
  let res = await sendClaimGQL(CLAIM_DROP_QUERY_HASH);
  let json = null;
  try {
    json = await res.json();
  } catch (e) {}

  // Attempt B: If integrity error, clear cached token, acquire fresh one and retry once
  if (json?.errors?.some((e) => e.message && e.message.toLowerCase().includes('integrity'))) {
    cachedIntegrityToken = null;
    integrityToken = await getTwitchIntegrityToken(authToken, deviceId);
    if (integrityToken) {
      baseHeaders['Client-Integrity'] = integrityToken;
      res = await sendClaimGQL(CLAIM_DROP_QUERY_HASH);
      try {
        json = await res.json();
      } catch (e) {}
    }
  }

  // Attempt C: fallback query hash if PersistedQueryNotFound
  if (json?.errors?.some((e) => e.message && e.message.includes('PersistedQueryNotFound'))) {
    res = await sendClaimGQL(CLAIM_DROP_QUERY_HASH_FALLBACK);
    try {
      json = await res.json();
    } catch (e) {}
  }

  // Attempt D: raw GraphQL mutation fallback
  if (!json || json.errors?.some((e) => e.message && e.message.includes('PersistedQueryNotFound'))) {
    const rawMutation = `
      mutation DropsPage_ClaimDropRewards($input: ClaimDropRewardsInput!) {
        claimDropRewards(input: $input) {
          status
        }
      }
    `;
    res = await sendClaimGQL(null, rawMutation);
    try {
      json = await res.json();
    } catch (e) {}
  }

  if (!res.ok) {
    throw new Error(`수령 요청 실패 (HTTP ${res.status})`);
  }

  if (json?.errors?.length) {
    const message = json.errors[0].message || '수령 요청 실패';
    throw new Error(/integrity/i.test(message) ? '트위치 보안 검증이 필요합니다. 보관함 링크에서 직접 확인해 주세요.' : message);
  }
  const claimStatus = json?.data?.claimDropRewards?.status;

  if (
    claimStatus === 'ELIGIBLE_FOR_ALL' ||
    claimStatus === 'DROP_INSTANCE_ALREADY_CLAIMED' ||
    claimStatus === 'SUCCESS'
  ) {
    return { success: true, status: claimStatus };
  }

  throw new Error(`트위치 수령을 확인하지 못했습니다 (${claimStatus || '응답 없음'}). 보관함에서 확인해 주세요.`);
}
