import { fetchWithTimeout } from './fetch-helper.js';
import { getHandledDropsLog, linkTwitchReceipt } from './storage.js';
import { fetchTwitchInventory } from './twitch.js';
import { dropsDay } from './drops-day.js';
import { buildCapturedTwitchRequestHeaders, clearCapturedTwitchGqlHeaders, getCapturedTwitchGqlHeaders, waitForCapturedTwitchGqlHeaders } from './twitch-headers.js';

const GQL_URL = 'https://gql.twitch.tv/gql';
const INVENTORY_URL = 'https://www.twitch.tv/drops/inventory';
const CHANNEL = /^[a-z0-9_]{1,25}$/i;
// These viewer-side fields are used by Twitch's own Drops pages. They may change;
// malformed or failed responses must never be treated as an empty campaign list.
const VIEWER = 'query HubDropsViewer { currentUser { id login } }';
const CAMPAIGNS = `query HubDropsCampaigns { currentUser { dropCampaigns {
  id name status startAt endAt self { isAccountConnected } game { id slug displayName }
} } }`;
const DETAILS = `query HubDropsDetails($login: String!, $id: ID!) {
  user(login: $login) { dropCampaign(id: $id) {
    id name status startAt endAt self { isAccountConnected } game { id slug displayName }
    allow { isEnabled channels { id name displayName } }
    timeBasedDrops { id name startAt endAt requiredMinutesWatched
      self { isClaimed currentMinutesWatched dropInstanceID } }
  } }
}`;
const ALLOWED_LIVES = `query HubDropsAllowedLives($logins: [String!]) {
  users(logins: $logins) { login stream { id viewersCount game { id } } }
}`;
const GAME_LIVES = `query HubDropsGameLives($slug: String!, $limit: Int!) {
  game(slug: $slug) { id streams(first: $limit, options: {
    includeRestricted: [SUB_ONLY_LIVE], systemFilters: [DROPS_ENABLED], sort: VIEWER_COUNT
  }) { edges { node { id viewersCount broadcaster { login } } } } }
}`;

export function isEternalReturnGame(game) {
  return game?.slug === 'eternal-return' || /^(eternal return(?:: black survival)?|이터널\s*리턴)$/i.test(String(game?.displayName || '').trim());
}

function validLogin(value) { return typeof value === 'string' && CHANNEL.test(value); }
function watched(drop) { return Number(drop?.self?.currentMinutesWatched) || 0; }
function required(drop) { return Number(drop?.requiredMinutesWatched) || 0; }

function accountReceipts(handled, twitchUserId) {
  return Object.values(handled || {}).filter(entry => entry?.platform === 'twitch' && entry.actionType === 'claimed' &&
    twitchUserId && entry.twitchUserId && String(entry.twitchUserId) === String(twitchUserId));
}
function receivedToday(entry, now) {
  const at = entry.claimedAt ?? (entry.receiptIdentityVerified && !entry.claimStatus ? entry.receivedAt ?? entry.handledAt : null);
  return Number.isFinite(at) && at > 0 && at <= now && dropsDay(at) === dropsDay(now);
}

async function linkLegacyReceipts(handled, details, progress, twitchUserId) {
  if (!twitchUserId) return;
  const instances = new Map();
  for (const campaign of details) {
    for (const drop of campaign.timeBasedDrops || []) {
      const fresh = progress.get(String(campaign.id))?.timeBasedDrops?.find(d => String(d.id) === String(drop.id));
      const instance = fresh?.self?.dropInstanceID || drop.self?.dropInstanceID;
      if (!instance || !drop.id) continue;
      const identity = { twitchUserId: String(twitchUserId), campaignId: String(campaign.id),
        timeBasedDropId: String(drop.id), dropInstanceId: instance };
      if (instances.has(instance) && JSON.stringify(instances.get(instance)) !== JSON.stringify(identity)) instances.set(instance, null);
      else if (!instances.has(instance)) instances.set(instance, identity);
    }
  }
  for (const [id, entry] of Object.entries(handled)) {
    if (entry?.platform !== 'twitch' || entry.actionType !== 'claimed') continue;
    if (entry.twitchUserId && entry.campaignId && entry.timeBasedDropId) continue;
    const instance = entry.dropInstanceId || (id.startsWith('twitch_') ? id.slice(7) : null);
    const identity = instances.get(instance);
    if (!identity) continue;
    const linked = await linkTwitchReceipt(id, identity);
    if (linked) handled[id] = linked;
  }
}

export function summarizeTwitchCampaign(detail, inventory, now = Date.now(), receiptContext = {}) {
  if (!detail?.id || !Array.isArray(detail.timeBasedDrops)) throw new Error('트위치 캠페인 보상 형식이 변경되었습니다.');
  const receipts = accountReceipts(receiptContext.handled, receiptContext.twitchUserId)
    .filter(entry => entry.campaignId && String(entry.campaignId) === String(detail.id));
  let claimedToday = 0;
  const fresh = new Map((inventory?.timeBasedDrops || []).filter(d => d?.id).map(d => [d.id, d.self]));
  const drops = detail.timeBasedDrops.map(drop => {
    const inventorySelf = fresh.get(drop.id);
    const receipt = receipts.find(entry => entry.timeBasedDropId && drop.id && String(entry.timeBasedDropId) === String(drop.id) &&
      (!entry.dropInstanceId || !(inventorySelf?.dropInstanceID || drop.self?.dropInstanceID) ||
        entry.dropInstanceId === (inventorySelf?.dropInstanceID || drop.self?.dropInstanceID)));
    if (receipt && receivedToday(receipt, now)) claimedToday++;
    const isClaimed = drop.self?.isClaimed === true || inventorySelf?.isClaimed === true || !!receipt;
    const currentMinutesWatched = Math.max(watched(drop), watched({ self: inventorySelf }));
    return { ...drop, self: { ...drop.self, ...inventorySelf,
      isClaimed, currentMinutesWatched } };
  });
  const startAt = Date.parse(detail.startAt), endAt = Date.parse(detail.endAt);
  const active = detail.status === 'ACTIVE' && Number.isFinite(startAt) && Number.isFinite(endAt) && startAt <= now && now < endAt;
  const claimed = drops.filter(d => d.self?.isClaimed === true).length;
  const pending = drops.filter(d => !d.self?.isClaimed && required(d) > 0 && watched(d) >= required(d)).length;
  const earned = claimed + pending;
  const claimable = drops.some(d => !d.self?.isClaimed && required(d) > 0 && watched(d) >= required(d));
  const needsLink = detail.self?.isAccountConnected === false;
  // A completed tier often needs claiming before Twitch advances the next one.
  const canWatch = drops.some(d => !d.self?.isClaimed && required(d) > watched(d));
  const watchable = !claimable && canWatch;
  const minutes = drops.length ? drops.reduce((sum, drop) => sum + watched(drop), 0) : null;
  return { id: String(detail.id), title: String(detail.name || '트위치 이터널리턴 드롭스'), active,
    completed: drops.length > 0 && claimed === drops.length, canWatch, watchable, claimable, needsLink, minutes,
    earned, claimed, pending, total: drops.length, claimedToday, endAt, game: detail.game,
    restricted: detail.allow?.isEnabled === true || (detail.allow?.isEnabled !== false && (detail.allow?.channels?.length || 0) > 0),
    allowed: detail.allow?.channels || [], lives: [] };
}

async function headersFromTwitchPage() {
  let capture = await getCapturedTwitchGqlHeaders();
  if (capture) return capture;
  // A temporary official inventory page supplies its own integrity headers.
  // Never reload or navigate a tab the user already had open.
  const tab = await chrome.tabs.create({ url: INVENTORY_URL, active: false });
  try {
    await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false });
    capture = await waitForCapturedTwitchGqlHeaders({ timeoutMs: 15000 });
    if (!capture) throw new Error('트위치 보관함의 인증 정보를 가져오지 못했습니다. 로그인 상태를 확인해 주세요.');
    return capture;
  } finally {
    try {
      const current = await chrome.tabs.get(tab.id);
      if (current.url?.startsWith(INVENTORY_URL) || current.pendingUrl?.startsWith(INVENTORY_URL) ||
          (current.status === 'loading' && current.url === 'about:blank')) await chrome.tabs.remove(tab.id);
    } catch { /* The temporary tab may already be closed. */ }
  }
}

async function gqlRequest(capture, body) {
  const { operationName } = body;
  let response;
  try {
    response = await fetchWithTimeout(GQL_URL, { method: 'POST',
      headers: buildCapturedTwitchRequestHeaders(capture),
      body: JSON.stringify(body) }, 10000);
  } catch { throw new Error('트위치 캠페인 조회 연결에 실패했습니다.'); }
  if (response.status === 401 || response.status === 403) {
    await clearCapturedTwitchGqlHeaders();
    throw new Error('트위치 로그인 또는 인증 정보가 만료되었습니다.');
  }
  if (!response.ok) throw new Error(`트위치 캠페인 조회 실패 (HTTP ${response.status})`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('트위치 캠페인 응답을 읽을 수 없습니다.'); }
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    if (payload.errors.some(e => /integrity|unauthori[sz]ed/i.test(String(e?.message || '')))) await clearCapturedTwitchGqlHeaders();
    throw new Error(`트위치 캠페인 조회가 거부되었습니다 (${operationName}). 다음 확인에서 다시 시도합니다.`);
  }
  if (!payload?.data || typeof payload.data !== 'object') throw new Error('트위치 캠페인 응답 형식이 변경되었습니다.');
  return payload.data;
}
function gql(capture, operationName, query, variables = {}) {
  return gqlRequest(capture, { operationName, query, variables });
}
function safeLives(rows, campaign) {
  const found = new Map();
  for (const row of rows) {
    const login = row?.login?.toLowerCase();
    if (!validLogin(login) || !row?.liveId) continue;
    found.set(login, { key: `twitch:${login}`, platform: 'twitch', channelId: login, liveId: String(row.liveId),
      name: login, viewers: Number(row.viewers) || 0, url: `https://www.twitch.tv/${login}` });
  }
  campaign.lives = [...found.values()].sort((a, b) => b.viewers - a.viewers);
}

export async function twitchPlan(now = Date.now(), currentChannel = null) {
  const capture = await headersFromTwitchPage();
  const [viewer, listed, inventory] = await Promise.all([
    gql(capture, 'HubDropsViewer', VIEWER),
    gql(capture, 'HubDropsCampaigns', CAMPAIGNS),
    fetchTwitchInventory(),
  ]);
  const login = viewer.currentUser?.login;
  if (!validLogin(login) || !listed.currentUser) throw new Error('트위치 로그인이 필요합니다.');
  if (inventory.error) throw new Error(inventory.error);
  if (inventory.twitchUserId && viewer.currentUser.id && String(inventory.twitchUserId) !== String(viewer.currentUser.id)) {
    await clearCapturedTwitchGqlHeaders();
    throw new Error('트위치 보관함과 캠페인 조회의 로그인 계정이 다릅니다. 다음 확인에서 인증 정보를 갱신합니다.');
  }
  const rawList = listed.currentUser.dropCampaigns;
  const inventoryList = inventory.campaigns;
  if (rawList !== null && !Array.isArray(rawList)) throw new Error('트위치 캠페인 목록 형식이 변경되었습니다.');
  if (inventoryList !== null && !Array.isArray(inventoryList)) throw new Error('트위치 보관함 형식이 변경되었습니다.');
  const progress = new Map((inventoryList || []).filter(c => c?.id).map(c => [String(c.id), c]));
  const active = (rawList || []).filter(c => c?.status === 'ACTIVE' && isEternalReturnGame(c.game) && Date.parse(c.endAt) > now);
  const details = await Promise.all(active.map(async c => {
    const data = await gql(capture, 'HubDropsDetails', DETAILS, { login, id: c.id });
    const detail = data.user?.dropCampaign;
    if (String(detail?.id) !== String(c.id) || !isEternalReturnGame(detail?.game)) throw new Error('트위치 캠페인 상세 정보가 일치하지 않습니다.');
    return detail;
  }));
  const handled = await getHandledDropsLog();
  await linkLegacyReceipts(handled, details, progress, viewer.currentUser.id);
  // Count confirmed receipts even if Twitch has already removed the campaign from its list.
  const claimedToday = new Set(accountReceipts(handled, viewer.currentUser.id)
    .filter(entry => entry.dropInstanceId && receivedToday(entry, now)).map(entry => entry.dropInstanceId)).size;
  const campaigns = details.map(detail => summarizeTwitchCampaign(detail, progress.get(String(detail.id)), now,
    { handled, twitchUserId: viewer.currentUser.id }));
  const liveQueries = new Map();
  for (const campaign of campaigns.filter(c => c.active && c.watchable)) {
    const allowed = campaign.allowed.map(c => c?.name?.toLowerCase()).filter(validLogin);
    if (campaign.restricted) {
      const chunks = [];
      for (let i = 0; i < allowed.length; i += 100) chunks.push(allowed.slice(i, i + 100));
      const pages = await Promise.all(chunks.map(logins => gql(capture, 'HubDropsAllowedLives', ALLOWED_LIVES, { logins })));
      const users = pages.flatMap(page => {
        if (!Array.isArray(page.users)) throw new Error('트위치 허용 방송 목록 형식이 변경되었습니다.');
        return page.users;
      });
      safeLives(users.filter(u => u?.stream?.id && String(u.stream.game?.id) === String(campaign.game?.id))
        .map(u => ({ login: u.login, liveId: u.stream.id, viewers: u.stream.viewersCount })), campaign);
    } else {
      const slug = campaign.game?.slug;
      if (!slug || !/^[a-z0-9-]{1,80}$/.test(slug)) throw new Error('트위치 게임 카테고리를 확인할 수 없습니다.');
      if (!liveQueries.has(slug)) liveQueries.set(slug, gql(capture, 'HubDropsGameLives', GAME_LIVES, { slug, limit: 30 }));
      const page = await liveQueries.get(slug);
      if (String(page.game?.id) !== String(campaign.game?.id) || !Array.isArray(page.game?.streams?.edges)) throw new Error('트위치 드롭스 방송 목록 형식이 변경되었습니다.');
      const rows = page.game.streams.edges.map(e => ({ login: e?.node?.broadcaster?.login,
        liveId: e?.node?.id, viewers: e?.node?.viewersCount }));
      if (validLogin(currentChannel) && !rows.some(row => row.login?.toLowerCase() === currentChannel.toLowerCase())) {
        const current = await gql(capture, 'HubDropsAllowedLives', ALLOWED_LIVES, { logins: [currentChannel] });
        if (!Array.isArray(current.users)) throw new Error('트위치 현재 방송 정보 형식이 변경되었습니다.');
        rows.push(...current.users.filter(u => u?.stream?.id && String(u.stream.game?.id) === String(campaign.game?.id))
          .map(u => ({ login: u.login, liveId: u.stream.id, viewers: u.stream.viewersCount })));
      }
      safeLives(rows, campaign);
    }
  }
  const candidates = campaigns.filter(c => c.active && c.watchable).sort((a, b) => a.endAt - b.endAt || a.id.localeCompare(b.id));
  return { login: login.toLowerCase(), twitchUserId: viewer.currentUser.id, campaigns, candidates, claimedToday,
    needsClaim: campaigns.some(c => c.claimable), needsLink: campaigns.some(c => c.needsLink),
    finished: campaigns.length > 0 && campaigns.every(c => c.completed) };
}
