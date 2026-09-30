import { dropsDay } from './drops-day.js';
import { fetchWithTimeout } from './fetch-helper.js';
import { getSettings } from './storage.js';

export const LIVE_ALARM = 'watchEternalReturnLives';
export const CHZZK_CATEGORY = 'Black_Survival_Eternal_Return';
export const SOOP_CATEGORY = '40120';
const SEEN_TTL = 7 * 86400000;
const MAX_PAGES = 10;
const TWITCH_PAGES = new Set(['drops', 'directory', 'search', 'settings', 'subscriptions', 'dashboard', 'login', 'logout', 'videos', 'wallet', 'inventory']);
let pending = null;

function enabled(value) { return value === true || value === 1 || value === '1' || value === 'Y'; }
function validId(value, pattern) { return typeof value === 'string' && pattern.test(value); }
export function normalizeChzzkLive(live) {
  if (!live || typeof live !== 'object') return null;
  const channelId = live.channel?.channelId;
  if (live.liveCategory !== CHZZK_CATEGORY || !Number.isFinite(Number(live.dropsCampaignNo)) || Number(live.dropsCampaignNo) <= 0) return null;
  if (!validId(channelId, /^[a-f0-9]{32}$/i) || !/^\d+$/.test(String(live.liveId))) return null;
  if (live.status && live.status !== 'OPEN') return null;
  return { key: `chzzk:${live.liveId}:${live.dropsCampaignNo}`, platform: 'chzzk', campaignId: String(live.dropsCampaignNo), notificationKey: `chzzk:campaign:${live.dropsCampaignNo}`, channelId, liveId: String(live.liveId),
    title: String(live.liveTitle || '이터널 리턴 드롭스 방송'), name: String(live.channel.channelName || '치지직 방송'),
    viewers: Number(live.concurrentUserCount) || 0, url: `https://chzzk.naver.com/live/${channelId}` };
}
export function normalizeSoopLive(live) {
  if (!live || typeof live !== 'object') return null;
  const userId = live.user_id;
  if (String(Number(live.broad_cate_no)) !== SOOP_CATEGORY || !enabled(live.is_drops)) return null;
  if (!validId(userId, /^[a-z0-9_-]{1,64}$/i) || !/^\d+$/.test(String(live.broad_no))) return null;
  // Password/subscriber-only streams cannot be opened as generally watchable broadcasts.
  if (enabled(live.is_password) || enabled(live.subscription_only)) return null;
  return { key: `soop:${live.broad_no}`, platform: 'soop', notificationKey: 'soop:category:' + SOOP_CATEGORY + ':' + dropsDay(), channelId: userId, liveId: String(live.broad_no),
    title: String(live.broad_title || '이터널 리턴 드롭스 방송'), name: String(live.user_nick || userId),
    viewers: Number(live.view_cnt) || 0, url: `https://play.sooplive.com/${userId}/${live.broad_no}` };
}
async function getJson(url) {
  let response;
  try { response = await fetchWithTimeout(url, { credentials: 'omit', headers: { Accept: 'application/json' } }, 12000); }
  catch (error) { throw new Error(error.name === 'AbortError' ? '방송 목록 연결 시간 초과 · 다음 주기에 재시도합니다.' : '방송 목록 연결 실패 · 다음 주기에 재시도합니다.'); }
  if (!response.ok) throw new Error(`방송 목록 조회 실패 (HTTP ${response.status})`);
  return response.json();
}
export async function fetchChzzkEternalLives() {
  const found = new Map(), cursors = new Set();
  let cursor = {};
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ size: '50', sortType: 'POPULAR', ...cursor });
    const json = await getJson(`https://api.chzzk.naver.com/service/v2/categories/GAME/${CHZZK_CATEGORY}/lives?${query}`);
    if (json.code !== 200 || !Array.isArray(json.content?.data)) throw new Error(json.message || '치지직 방송 목록 형식이 변경되었습니다.');
    for (const raw of json.content.data) { const live = normalizeChzzkLive(raw); if (live) found.set(live.key, live); }
    const next = json.content.page?.next;
    if (!next || json.content.data.length === 0) return [...found.values()];
    if (!/^\d+$/.test(String(next.liveId)) || !Number.isFinite(Number(next.concurrentUserCount))) throw new Error('치지직 방송 목록의 다음 페이지를 확인할 수 없습니다.');
    cursor = { liveId: String(next.liveId), concurrentUserCount: String(next.concurrentUserCount) };
    const token = JSON.stringify(cursor);
    if (cursors.has(token)) throw new Error('치지직 방송 목록 페이지가 반복됩니다.');
    cursors.add(token);
  }
  throw new Error('치지직 방송 목록이 너무 많아 전체 확인을 마치지 못했습니다.');
}
export async function fetchSoopEternalLives() {
  const found = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ m: 'categoryContentsList', szType: 'live', szCateNo: '00040120', szPlatform: 'pc', szOrder: 'view_cnt', nPageNo: String(page), nListCnt: '60' });
    const json = await getJson(`https://sch.sooplive.com/api.php?${query}`);
    if (json.result !== 1 || !Array.isArray(json.data?.list)) throw new Error(json.message || 'SOOP 방송 목록 형식이 변경되었습니다.');
    for (const raw of json.data.list) { const live = normalizeSoopLive(raw); if (live) found.set(live.key, live); }
    if (!enabled(json.data.is_more)) return [...found.values()];
    if (json.data.list.length === 0) throw new Error('SOOP 방송 목록의 다음 페이지를 확인할 수 없습니다.');
  }
  throw new Error('SOOP 방송 목록이 너무 많아 전체 확인을 마치지 못했습니다.');
}
export async function ensureLiveAlarm() {
  const settings = await getSettings();
  if (!settings.liveMonitorEnabled) { await chrome.alarms.clear(LIVE_ALARM); return; }
  if ((await chrome.alarms.get(LIVE_ALARM))?.periodInMinutes !== 1) await chrome.alarms.create(LIVE_ALARM, { periodInMinutes: 1 });
}
function liveAddress(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const authority = /^https:\/\/([^/?#]+)\//i.exec(url)?.[1];
    if (parsed.protocol !== 'https:' || authority?.toLowerCase() !== parsed.hostname ||
        parsed.username || parsed.password || parsed.port) return null;
    if (['www.twitch.tv', 'twitch.tv'].includes(parsed.hostname) && /^\/[a-z0-9_]{1,25}\/?$/i.test(parsed.pathname) &&
        !TWITCH_PAGES.has(parsed.pathname.split('/')[1].toLowerCase()))
      return { platform: 'twitch', path: parsed.pathname.replace(/\/$/, '').toLowerCase() };
    if (parsed.search || parsed.hash) return null;
    if (parsed.hostname === 'chzzk.naver.com' && /^\/live\/[a-f0-9]{32}$/i.test(parsed.pathname))
      return { platform: 'chzzk', path: parsed.pathname };
    if (['play.sooplive.com', 'play.sooplive.co.kr'].includes(parsed.hostname) &&
        /^\/[a-z0-9_-]{1,64}\/\d+$/i.test(parsed.pathname))
      return { platform: 'soop', path: parsed.pathname };
  } catch { /* Invalid URL. */ }
  return null;
}
export function validLiveUrl(url) {
  const address = liveAddress(url);
  if (!address) return false;
  if (address.platform !== 'twitch') return true;
  try { const parsed = new URL(url); return !parsed.search && !parsed.hash; } catch { return false; }
}
export function sameLiveUrl(expected, actual) {
  const first = liveAddress(expected), second = liveAddress(actual);
  return !!first && !!second && first.platform === second.platform &&
    (first.platform === 'soop' || first.platform === 'twitch' ? first.path === second.path : expected === actual);
}
async function openOnce(platform, live, allLives, state) {
  if (platform !== 'chzzk') return false;
  const patterns = platform === 'chzzk' ? ['https://chzzk.naver.com/live/*'] : ['https://play.sooplive.com/*', 'https://play.sooplive.co.kr/*'];
  const tabs = await chrome.tabs.query({ url: patterns });
  const matches = tab => allLives.some(item => {
    try {
      const url = new URL(tab.pendingUrl || tab.url);
      if (url.protocol !== 'https:') return false;
      if (platform === 'chzzk') return url.hostname === 'chzzk.naver.com' && url.pathname === `/live/${item.channelId}`;
      return ['play.sooplive.com', 'play.sooplive.co.kr'].includes(url.hostname) && (url.pathname === `/${item.channelId}` || url.pathname === `/${item.channelId}/` || url.pathname === `/${item.channelId}/${item.liveId}`);
    } catch { return false; }
  });
  if (tabs.some(matches)) return true;
  // Leave a user-navigated tab alone. Reuse only a tab still at the URL this monitor opened.
  const owned = state.openedTabs?.[platform];
  const tab = owned && tabs.find(t => t.id === owned.id && sameLiveUrl(owned.url, t.url) && (!t.pendingUrl || sameLiveUrl(owned.url, t.pendingUrl)));
  const settings = await getSettings();
  if (!settings.liveMonitorEnabled || !settings.liveAutoOpen || (platform === 'chzzk' && settings.autoCollectChzzk)) return;
  if (!validLiveUrl(live.url)) throw new Error('방송 주소가 올바르지 않습니다.');
  const opened = tab ? await chrome.tabs.update(tab.id, { url: live.url }) : await chrome.tabs.create({ url: live.url, active: false });
  state.openedTabs ||= {};
  state.openedTabs[platform] = { id: opened.id, url: live.url };
  return true;
}

async function check() {
  if (!(await getSettings()).liveMonitorEnabled) return;
  const stored = await chrome.storage.local.get('liveMonitorState');
  const state = stored.liveMonitorState || { seen: {}, openedTabs: {}, notices: {}, platforms: {} };
  const now = Date.now();
  const day = dropsDay(now);
  const previousDay = state.day || (state.checkedAt ? dropsDay(state.checkedAt) : day);
  if (previousDay !== day) {
    state.seen = {};
    state.notificationGroups = {};
  }
  state.day = day;
  state.seen = Object.fromEntries(Object.entries(state.seen || {}).filter(([, value]) => now - value.lastSeen < SEEN_TTL));
  // Migrate broadcast-level history so updating does not repeat existing alerts.
  if (!state.notificationGroups) {
    state.notificationGroups = {};
    for (const [key, entry] of Object.entries(state.seen)) {
      if (!entry.notified) continue;
      const campaign = key.match(/^chzzk:\d+:(\d+)$/);
      const group = campaign ? `chzzk:campaign:${campaign[1]}` : key.startsWith('soop:') ? 'soop:category:' + SOOP_CATEGORY + ':' + dropsDay(entry.lastSeen) : null;
      if (group) state.notificationGroups[group] = { lastSeen: entry.lastSeen, notified: true };
    }
  }
  state.notificationGroups = Object.fromEntries(Object.entries(state.notificationGroups).filter(([, value]) => now - value.lastSeen < 30 * 86400000));
  state.notices ||= {}; state.platforms ||= {};
  for (const [id, notice] of Object.entries(state.notices)) if (now - notice.createdAt > SEEN_TTL) delete state.notices[id];
  const results = await Promise.allSettled([fetchChzzkEternalLives(), fetchSoopEternalLives()]);
  // The user may turn the monitor off while the requests are in flight.
  if (!(await getSettings()).liveMonitorEnabled) return;
  for (const [index, platform] of ['chzzk', 'soop'].entries()) {
    const result = results[index];
    if (result.status === 'rejected') {
      state.platforms[platform] = { ...state.platforms[platform], error: result.reason?.message || '방송 조회 실패', checkedAt: now };
      continue;
    }
    const lives = result.value.sort((a, b) => b.viewers - a.viewers);
    state.platforms[platform] = { count: lives.length, checkedAt: now, error: null, liveNames: lives.slice(0, 3).map(l => l.name) };
    for (const live of lives) state.seen[live.key] = { ...state.seen[live.key], lastSeen: now };
    let settings = await getSettings();
    if (!settings.liveMonitorEnabled) break;
    for (const live of lives) {
      state.notificationGroups[live.notificationKey] = { ...state.notificationGroups[live.notificationKey], lastSeen: now };
    }
    const fresh = lives.filter(live => !state.notificationGroups[live.notificationKey].notified);
    if (fresh.length) {
      const id = `er-live:${platform}:${crypto.randomUUID()}`;
      state.notices[id] = { url: fresh[0].url, createdAt: now };
      // Save the click target before displaying the notification.
      await chrome.storage.local.set({ liveMonitorState: state });
      try {
        if (!(await getSettings()).liveMonitorEnabled) break;
        await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
          title: `[${platform === 'chzzk' ? '치지직' : 'SOOP'}] 이터널리턴 드롭스 방송 ${fresh.length}개 발견`,
          message: `${fresh.slice(0, 3).map(l => l.name).join(', ')}${fresh.length > 3 ? ' 외' : ''}\n클릭하면 방송을 엽니다.` });
        for (const live of fresh) {
          state.seen[live.key].notified = true;
          state.notificationGroups[live.notificationKey].notified = true;
        }
        await chrome.storage.local.set({ liveMonitorState: state });
      } catch (error) { state.platforms[platform].actionError = '알림 표시 실패: ' + error.message; }
    }
    settings = await getSettings();
    if (platform === 'chzzk' && settings.liveMonitorEnabled && settings.liveAutoOpen && !settings.autoCollectChzzk) {
      const unopened = lives.filter(live => !state.seen[live.key].opened);
      if (unopened.length) {
        try {
          const opened = await openOnce(platform, unopened[0], lives, state);
          if (opened) {
            for (const live of lives) state.seen[live.key].opened = true;
            await chrome.storage.local.set({ liveMonitorState: state });
          }
        } catch (error) { state.platforms[platform].actionError = '방송 열기 실패: ' + error.message; }
      }
    }
  }
  state.checkedAt = now;
  await chrome.storage.local.set({ liveMonitorState: state });
}
export function checkLiveMonitor() {
  if (pending) return pending;
  pending = check().finally(() => { pending = null; });
  return pending;
}
export async function openLiveNotification(id) {
  if (!id.startsWith('er-live:')) return;
  const { liveMonitorState } = await chrome.storage.local.get('liveMonitorState');
  const notice = liveMonitorState?.notices?.[id];
  if (!notice || Date.now() - notice.createdAt > SEEN_TTL || !validLiveUrl(notice.url)) return;
  const tabs = await chrome.tabs.query({ url: notice.url });
  if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url: notice.url, active: true });
}
