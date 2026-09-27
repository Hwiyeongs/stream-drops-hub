import { dropsDay } from './drops-day.js';
import { getSettings } from './storage.js';
import { chzzkPlan, soopPlan } from './collector-plans.js';
import { validLiveUrl, sameLiveUrl } from './live-monitor.js';

export const COLLECT_ALARM = 'collectEternalReturnDrops';
const flag = p => p === 'chzzk' ? 'autoCollectChzzk' : 'autoCollectSoop';
let pending;
export async function ensureCollectorAlarm() {
  const s = await getSettings();
  if (!s.autoCollectChzzk && !s.autoCollectSoop) { await chrome.alarms.clear(COLLECT_ALARM); return; }
  if ((await chrome.alarms.get(COLLECT_ALARM))?.periodInMinutes !== 1) await chrome.alarms.create(COLLECT_ALARM, { periodInMinutes: 1 });
}
// Executed only in an extension-created tab still showing the owned broadcast.
export async function controlVideo(expectedUrl, start = false, platform = 'chzzk') {
  // This function is serialized into the page; imported helpers are unavailable there.
  const sameLocation = current => {
    if (current === expectedUrl) return true;
    if (platform !== 'soop') return false;
    try {
      const first = new URL(expectedUrl), second = new URL(current);
      const hosts = ['play.sooplive.com', 'play.sooplive.co.kr'];
      const safe = (raw, parsed) => /^https:\/\/([^/?#]+)\//i.exec(raw)?.[1]?.toLowerCase() === parsed.hostname &&
        parsed.protocol === 'https:' && hosts.includes(parsed.hostname) && !parsed.username &&
        !parsed.password && !parsed.port && !parsed.search && !parsed.hash &&
        /^\/[a-z0-9_-]{1,64}\/\d+$/i.test(parsed.pathname);
      return safe(expectedUrl, first) && safe(current, second) && first.pathname === second.pathname;
    } catch { return false; }
  };
  if (!sameLocation(location.href)) return { state: 'navigation' };
  const videos = [...document.querySelectorAll('video')];
  const visible = videos.filter(v => {
    const r = v.getBoundingClientRect(); return r.width > 120 && r.height > 80;
  }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  // A single player can report zero layout size while its window is occluded.
  const video = (platform === 'soop' ? document.querySelector('video#livePlayer') : null) || visible[0] || (videos.length === 1 ? videos[0] : null);
  if (!video) return { state: 'missing' };
  const result = (state, reason = null, deltaSeconds = 0) => ({
    state, reason, readyState: video.readyState, networkState: video.networkState,
    paused: video.paused, ended: video.ended, muted: video.muted,
    deltaSeconds: Math.round(deltaSeconds * 100) / 100,
  });
  // Browser-tab mute does not make the media element eligible for muted autoplay.
  if (start) { video.defaultMuted = true; video.muted = true; }
  if (start && platform === 'soop') {
    // SOOP's initial data:video is a short placeholder. Its own play control
    // starts the live stream; playing the placeholder alone never joins it.
    const playButton = document.querySelector('button#play.play');
    if (playButton && (video.paused || video.ended || video.currentSrc?.startsWith('data:video/'))) {
      playButton.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      video.muted = true;
    }
    if (video.currentSrc?.startsWith('data:video/')) return result('loading', 'SoopPlayerStarting');
  }
  if (video.error) return result('error', `MediaError${Number(video.error.code) || 0}`);
  if (video.paused && !start) return result('paused');
  if (video.paused) {
    let timer;
    try {
      await Promise.race([
        video.play(),
        new Promise((_, reject) => { timer = setTimeout(() => reject({ name: 'TimeoutError' }), 4000); }),
      ]);
    } catch (error) {
      const reason = ['NotAllowedError', 'AbortError', 'NotSupportedError', 'TimeoutError'].includes(error?.name) ? error.name : 'PlaybackError';
      return result('blocked', reason);
    } finally { clearTimeout(timer); }
  }
  const before = video.currentTime;
  await new Promise(resolve => setTimeout(resolve, 2500));
  if (!sameLocation(location.href)) return result('navigation');
  const delta = Math.max(0, video.currentTime - before);
  if (start) video.muted = true;
  return result(!video.paused && !video.ended && delta > 0.1 ? 'playing' : 'stalled', null, delta);
}
async function probe(session, start = false, platform = 'chzzk') {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: session.tabId }, func: controlVideo, args: [session.url, start, platform] });
    return results?.[0]?.result || { state: 'missing' };
  } catch { return { state: 'injection_error', reason: 'ScriptingFailure' }; }
}
// Activate only for startup/recovery. Never take focus back after a user switches tabs.
async function startPlayback(session, platform, previousTab, fromBlank = false) {
  session.lastStartAt = Date.now();
  let playback = { state: 'missing' };
  const windowId = (await chrome.tabs.get(session.tabId)).windowId;
  try {
    await chrome.tabs.update(session.tabId, { active: true, muted: true, autoDiscardable: false });
    for (let attempt = 0; attempt < 8; attempt++) {
      const settings = await getSettings();
      if (!settings[flag(platform)]) return { state: 'cancelled' };
      const tab = await chrome.tabs.get(session.tabId);
      const initialBlank = fromBlank && tab.url === 'about:blank' && (!tab.pendingUrl || sameLiveUrl(session.url, tab.pendingUrl));
      const reloading = tab.status === 'loading' && !tab.pendingUrl && (!tab.url || tab.url === 'about:blank');
      if (!initialBlank && !reloading && ((tab.pendingUrl && !sameLiveUrl(session.url, tab.pendingUrl)) || (!tab.pendingUrl && !sameLiveUrl(session.url, tab.url)))) return { state: 'navigation' };
      if (!tab.active) return { state: 'interrupted' };
      if (initialBlank || reloading || tab.discarded || tab.status === 'loading') {
        playback = { state: tab.discarded ? 'discarded' : 'loading' };
        session.diagnostic = { platform, ...playback, attempt: attempt + 1, checkedAt: Date.now() };
      } else if (sameLiveUrl(session.url, tab.url)) {
        playback = await probe(session, true, platform);
        session.diagnostic = { platform, ...playback, attempt: attempt + 1, checkedAt: Date.now() };
        if (playback.state === 'playing') return playback;
        if (playback.state === 'navigation') return playback;
      }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return playback;
  } finally {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (previousTab && previousTab.id !== session.tabId && active?.id === session.tabId) {
      try {
        const previous = await chrome.tabs.get(previousTab.id);
        if (previous.windowId === windowId) await chrome.tabs.update(previous.id, { active: true });
      } catch { /* Previous tab may have been closed. */ }
    }
  }
}
async function ownedTab(session) {
  if (!session?.tabId) return null;
  try {
    const tab = await chrome.tabs.get(session.tabId);
    return (sameLiveUrl(session.url, tab.url) || sameLiveUrl(session.url, tab.pendingUrl)) &&
      (!tab.pendingUrl || sameLiveUrl(session.url, tab.pendingUrl)) ? tab : null;
  } catch { return null; }
}
async function loadingOwnedTab(session) {
  if (!session?.tabId) return false;
  try {
    const tab = await chrome.tabs.get(session.tabId);
    // Chrome can briefly expose about:blank without pendingUrl during a reload.
    // A completed navigation or a different pendingUrl still means the user left.
    return tab.status === 'loading' && !tab.pendingUrl && (!tab.url || tab.url === 'about:blank');
  } catch { return false; }
}
async function release(session) {
  const tab = await ownedTab(session);
  if (tab) await chrome.tabs.remove(tab.id);
}
export function chooseTarget(plan, session, selected, now = Date.now()) {
  const choices = plan.candidates.filter(c => c.lives.length);
  const current = choices.find(c => c.id === session?.campaignId);
  // Finish the selected campaign before moving on, even if viewer counts change.
  const campaign = current || choices[0];
  if (!campaign) {
    if (plan.discoveryLives?.length) return { campaign: { id: 'discovery', title: 'SOOP 미션 참여 확인 중', minutes: null }, live: plan.discoveryLives.find(l => l.key === session?.liveKey) || plan.discoveryLives[0] };
    return null;
  }
  const available = campaign.lives.filter(l => (session?.cooldowns?.[l.key] || 0) <= now).sort((a,b) => b.viewers - a.viewers);
  const live = available.find(l => l.key === session?.liveKey) || available[0];
  return live ? { campaign, live } : null;
}
async function persist(state) { await chrome.storage.local.set({ collectorState: state }); }
async function run() {
  const { collectorState = {} } = await chrome.storage.local.get('collectorState');
  const state = collectorState;
  const day = dropsDay();
  if (state.day && state.day !== day) {
    for (const platform of ['chzzk', 'soop']) {
      const old = state[platform] || {};
      // Keep ownership of a still-open stream; never close a user-navigated tab.
      const tab = await ownedTab(old);
      state[platform] = (tab || await loadingOwnedTab(old)) ? { tabId: old.tabId, url: old.url, liveKey: old.liveKey,
        campaignId: old.campaignId, progressAt: Date.now() } : {};
    }
  }
  state.day = day;
  for (const platform of ['chzzk', 'soop']) {
    let settings = await getSettings();
    let session = state[platform] || {};
    if (!settings[flag(platform)]) {
      await release(session);
      state[platform] = { status: '꺼짐', checkedAt: Date.now() };
      await persist(state); continue;
    }
    if (session.userStopped) { session.status = '탭을 닫거나 이동하여 일시 중지됨 · 토글을 껐다 켜면 재개'; await persist(state); continue; }
    state[platform] = session;
    try {
      const selected = settings.chzzkCollectCampaign || 'auto';
      if (session.tabId && !await ownedTab(session)) {
        if (await loadingOwnedTab(session)) {
          session.status = '방송 페이지 다시 로딩 중 · 다음 확인에서 재생 상태 확인';
          session.checkedAt = Date.now(); await persist(state); continue;
        }
        session.userStopped = true; session.status = '탭을 닫거나 이동하여 일시 중지됨'; await persist(state); continue;
      }
      const plan = platform === 'chzzk' ? await chzzkPlan(selected) : await soopPlan();
      session.campaigns = plan.campaigns.map(c => ({ id:c.id, title:c.title, completed:c.completed, active:c.active, minutes:c.minutes, earned:c.earned, total:c.total }));
      if (plan.catalog) session.catalog = plan.catalog;
      settings = await getSettings();
      if (!settings[flag(platform)]) { await release(session); state[platform] = { status: '꺼짐' }; await persist(state); continue; }
      if (platform === 'chzzk' && settings.chzzkCollectCampaign !== selected) continue;
      const target = chooseTarget(plan, session, selected);
      if (!target) {
        await release(session); delete session.tabId; delete session.url;
        session.status = plan.finished ? '대상 캠페인 완료·종료·보상 소진 · 자동 시청 대기' : '선택한 캠페인의 대상 방송 대기 중';
        session.checkedAt = Date.now(); await persist(state); continue;
      }
      const { campaign, live } = target;
      if (!validLiveUrl(live.url)) throw new Error('대상 방송 주소가 올바르지 않습니다.');
      let tab = await ownedTab(session);
      const patterns = platform === 'chzzk' ? ['https://chzzk.naver.com/live/*'] : ['https://play.sooplive.com/*', 'https://play.sooplive.co.kr/*'];
      const others = (await chrome.tabs.query({ url: patterns })).filter(t => t.id !== tab?.id);
      if (others.length) {
        await release(session); delete session.tabId; delete session.url;
        session.status = '다른 방송 탭을 닫아 주세요 · 중복 시청으로 적립이 멈출 수 있어 대기 중';
        await persist(state); continue;
      }
      settings = await getSettings();
      if (!settings[flag(platform)] || (platform === 'chzzk' && settings.chzzkCollectCampaign !== selected)) continue;
      let playback;
      if (!tab || session.url !== live.url || session.liveKey !== live.key) {
        const [previousActive] = await chrome.tabs.query({ active: true, ...(tab ? { windowId: tab.windowId } : { lastFocusedWindow: true }) });
        const previous = tab;
        if (previous) {
          tab = await chrome.tabs.update(tab.id, { url: live.url, muted: true, autoDiscardable: false });
        } else {
          // Mute an empty owned tab before loading the broadcaster page.
          tab = await chrome.tabs.create({ url: 'about:blank', active: false });
          try {
            await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false });
            tab = await chrome.tabs.update(tab.id, { url: live.url });
          } catch (error) {
            try { if ((await chrome.tabs.get(tab.id)).url === 'about:blank') await chrome.tabs.remove(tab.id); } catch {}
            throw error;
          }
        }
        Object.assign(session, { tabId: tab.id, url: live.url, liveKey: live.key, campaignId: campaign.id, title: campaign.title, openedAt: Date.now(), failures: 0, lastProgress: campaign.minutes, progressAt: Date.now() });
        await persist(state);
        playback = await startPlayback(session, platform, previousActive, !previous);
      } else {
        playback = tab.discarded ? { state: 'discarded' } : await probe(session, false, platform);
        session.diagnostic = { platform, ...playback, attempt: 0, checkedAt: Date.now() };
        if (playback.state !== 'playing' && playback.state !== 'navigation' &&
            (tab.discarded || Date.now() - (session.lastStartAt || 0) >= 60000)) {
          if (platform === 'soop' && !tab.discarded) {
            // A single background probe can miss a playing stream. Retry the
            // existing player without pulling the user's tab into focus.
            playback = await probe(session, true, platform);
            session.diagnostic = { platform, ...playback, attempt: 1, recovery: 'background', checkedAt: Date.now() };
          } else {
            const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
            playback = await startPlayback(session, platform, previousActive);
          }
        } else if (playback.state === 'playing' && await ownedTab(session)) {
          await chrome.tabs.update(session.tabId, { muted: true, autoDiscardable: false });
        }
      }
      {
        if (playback.state === 'cancelled') { await release(session); state[platform] = { status: '꺼짐' }; await persist(state); continue; }
        if (playback.state === 'navigation') { session.userStopped = true; session.status = '방송 페이지 이동 감지 · 일시 중지'; }
        else if (playback.state === 'interrupted') {
          session.status = `${campaign.title} · 탭 전환 감지 · 다음 확인에서 재생 상태를 다시 확인합니다`;
        } else {
          const playing = playback.state === 'playing';
          session.failures = playing ? 0 : (session.failures || 0) + 1;
          const reason = playback.reason ? ` (${playback.reason})` : '';
          const detail = playback.state === 'missing' ? '플레이어 미감지 · 로그인/재생 화면 확인 필요'
            : playback.state === 'blocked' ? `음소거 재생 실패${reason} · 다음 확인에서 재시도`
            : playback.state === 'injection_error' ? '플레이어 검사 실패 · 다음 확인에서 재시도'
            : '재생 재시도 중';
          session.status = `${campaign.title} · ${playing ? '재생 중' : detail}`;
          if (session.failures >= 3) {
            session.cooldowns ||= {}; session.cooldowns[live.key] = Date.now() + 10 * 60000;
            session.status = `재생 오류${reason} · 다음 확인에서 다른 대상 방송으로 전환`;
          }
        }
        if (campaign.minutes !== null && campaign.minutes !== session.lastProgress) { session.lastProgress = campaign.minutes; session.progressAt = Date.now(); }
        if (campaign.minutes !== null) session.status += ` · 서버 시청 ${campaign.minutes}분 (${campaign.earned}/${campaign.total}개 달성)`;
        if (Date.now() - session.progressAt > 10 * 60000) session.status += ' · 적립 증가 미확인: 로그인/계정 연결/다른 시청 기기를 확인해 주세요';
      }
      session.checkedAt = Date.now(); session.error = null;
    } catch (error) {
      session.error = error.message; session.status = '조회/처리 실패 · ' + error.message;
      // Do not navigate away or mark rewards complete on API errors.
      session.checkedAt = Date.now();
    }
    await persist(state);
  }
}
export function checkCollector(afterCurrent = false) {
  if (pending) return afterCurrent ? pending.then(() => checkCollector()) : pending;
  pending = run().finally(() => { pending = null; });
  return pending;
}
