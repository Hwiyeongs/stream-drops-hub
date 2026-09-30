import { dropsDay } from './drops-day.js';
import { getSettings } from './storage.js';
import { chzzkPlan } from './collector-plans.js';
import { twitchPlan } from './twitch-collector-plan.js';
import { validLiveUrl, sameLiveUrl } from './live-monitor.js';

export const COLLECT_ALARM = 'collectEternalReturnDrops';
const PLATFORMS = ['chzzk', 'twitch'];
const flag = p => ({ chzzk: 'autoCollectChzzk', twitch: 'autoCollectTwitch' })[p];
let pending;
export async function ensureCollectorAlarm() {
  // Retire only the legacy collector's owned SOOP tab, preserving user tabs.
  const { collectorState } = await chrome.storage.local.get('collectorState');
  if (collectorState?.soop) await checkCollector(true);
  const s = await getSettings();
  if (!s.autoCollectChzzk && !s.autoCollectTwitch) { await chrome.alarms.clear(COLLECT_ALARM); return; }
  if ((await chrome.alarms.get(COLLECT_ALARM))?.periodInMinutes !== 1) await chrome.alarms.create(COLLECT_ALARM, { periodInMinutes: 1 });
}
// Executed only in an extension-created tab still showing the owned broadcast.
export async function controlVideo(expectedUrl, start = false, platform = 'chzzk') {
  // This function is serialized into the page; imported helpers are unavailable there.
  const sameLocation = current => {
    if (current === expectedUrl) return true;
    if (platform === 'twitch') {
      try {
        const first = new URL(expectedUrl), second = new URL(current);
        return first.protocol === 'https:' && second.protocol === 'https:' && ['www.twitch.tv', 'twitch.tv'].includes(first.hostname) &&
          ['www.twitch.tv', 'twitch.tv'].includes(second.hostname) && !second.username && !second.password && !second.port &&
          /^\/[a-z0-9_]{1,25}\/?$/i.test(first.pathname) &&
          first.pathname.replace(/\/$/, '').toLowerCase() === second.pathname.replace(/\/$/, '').toLowerCase();
      } catch { return false; }
    }
    return false;
  };
  if (!sameLocation(location.href)) return { state: 'navigation' };
  const visibility = () => ({ hidden: document.visibilityState === 'hidden', hasFocus: document.hasFocus?.() ?? null });
  // PZP can place its video and controls inside an open shadow root.
  const roots = [document];
  const refreshRoots = () => {
    for (let i = 0; i < roots.length && i < 32; i++) {
      let visited = 0;
      for (const node of roots[i].querySelectorAll('*')) {
        if (++visited > 2500) break;
        if (roots.length < 32 && node.shadowRoot && !roots.includes(node.shadowRoot)) roots.push(node.shadowRoot);
      }
    }
  };
  refreshRoots();
  const query = selector => roots.map(root => root.querySelector?.(selector)).find(Boolean);
  const findVideo = () => {
    refreshRoots();
    // CHZZK can render an ad video beside the actual PZP live player.
    const videos = [...new Set(roots.flatMap(root => [...root.querySelectorAll('video')]))].filter(v => platform !== 'chzzk' ||
      !v.closest?.("[data-role='adVideoContainerEl'],[data-role='imaAdContainerEl'],[data-role='gvAdContainerEl'],#midAdVideoContainer,#midAdPlayerWrapper,video[title='Advertisement' i]"));
    const visible = videos.filter(v => {
      const r = v.getBoundingClientRect(); return r.width > 120 && r.height > 80;
    }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const primary = platform === 'chzzk' ? videos.find(v => v.matches?.("video[data-role='videoEl']")) :
      platform === 'twitch' ? videos.find(v => v.closest?.('[data-a-target="video-player"],.video-player__container,.video-player')) : null;
    // A single player can report zero layout size while its window is occluded.
    return primary ||
      visible[0] || (videos.length === 1 ? videos[0] : null);
  };
  let video = findVideo();
  const restorePlayerSound = () => {
    if (!video) return;
    video.defaultMuted = false;
    video.muted = false;
    if (video.volume === 0) video.volume = 1;
  };
  if (start && platform === 'chzzk' && (!video || video.paused || video.ended)) {
    // The site's own control can initialize the live player before a video exists.
    const playButton = query('.pzp-brand-playback-button,.pzp-playback-switch');
    if (playButton && !playButton.disabled) {
      restorePlayerSound();
      playButton.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      video = findVideo();
    }
  }
  if (start && platform === 'twitch' && (!video || video.paused || video.ended)) {
    const playButton = query('[data-a-target="player-play-pause-button"]');
    if (playButton && !playButton.disabled) {
      restorePlayerSound();
      playButton.click();
      await new Promise(resolve => setTimeout(resolve, 500));
      video = findVideo();
    }
  }
  if (!video) return { state: 'missing', reason: 'PlayerVideoMissing', ...visibility() };
  const result = (state, reason = null, deltaSeconds = 0) => ({
    state, reason, ...visibility(), readyState: video.readyState, networkState: video.networkState,
    paused: video.paused, ended: video.ended, muted: video.muted,
    deltaSeconds: Math.round(deltaSeconds * 100) / 100,
  });
  // Tab mute is separate from the site's player mute state. A player muted by
  // the site can fail to earn watch progress even while the video clock moves.
  restorePlayerSound();
  if (video.error) return result('error', `MediaError${Number(video.error.code) || 0}`);
  if (video.paused && !start) return result('paused');
  let mutedFallback = false;
  if (video.paused) {
    const playWithinTimeout = async () => {
      let timer;
      try {
        await Promise.race([
          video.play(),
          new Promise((_, reject) => { timer = setTimeout(() => reject({ name: 'TimeoutError' }), 4000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      await playWithinTimeout();
    } catch (error) {
      if (error?.name === 'NotAllowedError') {
        // Chrome permits muted autoplay even when audible autoplay is blocked.
        // Use that only to start playback, then restore the player's sound.
        video.defaultMuted = true;
        video.muted = true;
        try { await playWithinTimeout(); error = null; mutedFallback = true; }
        catch (retryError) { error = retryError; }
        finally { restorePlayerSound(); }
      }
      if (error) {
        const reason = ['NotAllowedError', 'AbortError', 'NotSupportedError', 'TimeoutError'].includes(error?.name) ? error.name : 'PlaybackError';
        return result('blocked', reason);
      }
    }
  }
  restorePlayerSound();
  if (mutedFallback && video.paused) return result('blocked', 'AutoplayUnmutePaused');
  const before = video.currentTime;
  await new Promise(resolve => setTimeout(resolve, 2500));
  if (!sameLocation(location.href)) return result('navigation');
  const delta = Math.max(0, video.currentTime - before);
  restorePlayerSound();
  if (video.muted || video.volume === 0) return result('blocked', 'PlayerMuted', delta);
  return result(!video.paused && !video.ended && delta > 0.1 ? 'playing' : 'stalled', null, delta);
}
async function probe(session, start = false, platform = 'chzzk') {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: session.tabId }, func: controlVideo, args: [session.url, start, platform] });
    return results?.[0]?.result || { state: 'missing' };
  } catch { return { state: 'injection_error', reason: 'ScriptingFailure' }; }
}
// An alarm has no user activation. Chrome may pause on player unmute even
// with a muted browser tab; use a short gesture-scoped playback evaluation.
export async function startWithBrowserGesture(session) {
  if (!/^https:\/\/chzzk\.naver\.com\/live\/[a-f0-9]{32}$/i.test(session?.url || '')) return { state: 'navigation' };
  const { collectorState } = await chrome.storage.local.get('collectorState');
  const owner = collectorState?.chzzk;
  if (owner?.tabId !== session.tabId || owner?.url !== session.url || owner.userStopped) return { state: 'navigation' };
  if (!chrome.debugger) return { state: 'blocked', reason: 'BrowserGestureUnavailable' };
  const target = { tabId: session.tabId };
  let attached = false;
  try {
    const tab = await ownedTab(session);
    if (!tab) return { state: 'navigation' };
    if (!(await getSettings()).autoCollectChzzk) return { state: 'cancelled' };
    if (!tab.active) return { state: 'interrupted' };
    if (tab.status === 'loading' || !sameLiveUrl(session.url, tab.url)) return { state: 'loading' };
    await chrome.tabs.update(tab.id, { muted: true, autoDiscardable: false });
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    // Revalidate after attaching; never run playback against a user navigation.
    const current = await ownedTab(session);
    if (!current) return { state: 'navigation' };
    if (!current.active) return { state: 'interrupted' };
    if (current.status === 'loading' || !sameLiveUrl(session.url, current.url)) return { state: 'loading' };
    if (!(await getSettings()).autoCollectChzzk) return { state: 'cancelled' };
    const response = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(${controlVideo.toString()})(${JSON.stringify(session.url)}, true, 'chzzk')`,
      userGesture: true, awaitPromise: true, returnByValue: true,
    });
    return response?.exceptionDetails ? { state: 'blocked', reason: 'BrowserGestureFailed' } :
      response?.result?.value || { state: 'blocked', reason: 'BrowserGestureFailed' };
  } catch {
    return { state: 'blocked', reason: 'BrowserGestureUnavailable' };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch { /* Target may have closed. */ }
    }
  }
}
// Activate only for startup/recovery. Never take focus back after a user switches tabs.
async function startPlayback(session, platform, previousTab, fromBlank = false, alreadyActive = false) {
  session.lastStartAt = Date.now();
  let playback = { state: 'missing' };
  let gestureTried = false;
  const windowId = (await chrome.tabs.get(session.tabId)).windowId;
  try {
    if (!alreadyActive) await chrome.tabs.update(session.tabId, { active: true, muted: true, autoDiscardable: false });
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
        session.diagnostic = { platform, ...playback, browserGesture: gestureTried, attempt: attempt + 1, checkedAt: Date.now() };
      } else if (sameLiveUrl(session.url, tab.url)) {
        playback = await probe(session, true, platform);
        if (platform === 'chzzk' && !gestureTried && playback.hidden !== true &&
            ['NotAllowedError', 'AutoplayUnmutePaused'].includes(playback.reason)) {
          gestureTried = true;
          playback = await startWithBrowserGesture(session);
          session.usedBrowserGesture = playback.state === 'playing';
        }
        session.diagnostic = { platform, ...playback, browserGesture: gestureTried, attempt: attempt + 1, checkedAt: Date.now() };
        if (playback.state === 'playing' || playback.state === 'navigation') break;
      }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (previousTab && previousTab.id !== session.tabId && active?.id === session.tabId) {
      try {
        const previous = await chrome.tabs.get(previousTab.id);
        if (previous.windowId === windowId) await chrome.tabs.update(previous.id, { active: true });
      } catch { /* Previous tab may have been closed. */ }
    }
  }
  if ((platform === 'chzzk' || platform === 'twitch') && playback.state === 'playing' && previousTab?.id !== session.tabId) {
    const tab = await chrome.tabs.get(session.tabId);
    if (!tab.active) {
      // CHZZK may pause as soon as its tab becomes hidden. Verify after restoring
      // the user's tab, then retry inside the owned tab without changing focus.
      playback = await probe(session, false, platform);
      session.diagnostic = { platform, ...playback, attempt: 9, recovery: 'background-check', checkedAt: Date.now() };
      if (playback.state !== 'playing' && playback.state !== 'navigation') {
        playback = await probe(session, true, platform);
        session.diagnostic = { platform, ...playback, attempt: 10, recovery: 'background', checkedAt: Date.now() };
      }
    }
  }
  return playback;
}
async function recoverChzzk(session, previousPlayback) {
  if (Date.now() - (session.lastForegroundRecoveryAt || 0) < 10 * 60000) return previousPlayback;
  const settings = await getSettings();
  const tab = await ownedTab(session);
  if (!settings.autoCollectChzzk) return { state: 'cancelled' };
  if (!tab) return { state: 'navigation' };
  if (tab.status === 'loading') return { state: 'loading' };
  session.lastForegroundRecoveryAt = Date.now();
  const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  let windowBefore, previousWindow, focusedForRecovery = false;
  let playback = previousPlayback;
  try {
    if (chrome.windows) {
      windowBefore = await chrome.windows.get(tab.windowId);
      previousWindow = await chrome.windows.getLastFocused();
      if (!windowBefore.focused || windowBefore.state === 'minimized') {
        await chrome.windows.update(tab.windowId, { focused: true,
          ...(windowBefore.state === 'minimized' ? { state: 'normal' } : {}) });
        focusedForRecovery = true;
      }
    }
    if (!await ownedTab(session)) return { state: 'navigation' };
    if (!(await getSettings()).autoCollectChzzk) return { state: 'cancelled' };
    await chrome.tabs.update(session.tabId, { active: true, muted: true, autoDiscardable: false });
    // Recreate an errored/stuck player once per recovery interval, only in our tab.
    if ((['error', 'stalled', 'missing'].includes(previousPlayback.state) || (session.failures || 0) >= 2) && chrome.tabs.reload) {
      const current = await ownedTab(session);
      if (!current) return { state: 'navigation' };
      if (!current.active) return { state: 'interrupted' };
      if (!(await getSettings()).autoCollectChzzk) return { state: 'cancelled' };
      await chrome.tabs.reload(session.tabId);
    }
    playback = await startPlayback(session, 'chzzk', previousActive, false, true);

  } catch {
    session.diagnostic = { ...session.diagnostic, recovery: 'foreground', reason: 'RecoveryFailure', checkedAt: Date.now() };
    playback = { state: 'injection_error', reason: 'RecoveryFailure' };
  } finally {
    if (focusedForRecovery) {
      try {
        // A user switching to a different tab/window wins over our restoration.
        const currentWindow = await chrome.windows.get(tab.windowId);
        const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        if (currentWindow.focused && (active?.id === previousActive?.id || active?.id === session.tabId)) {
          if (windowBefore.state === 'minimized') await chrome.windows.update(tab.windowId, { state: 'minimized' });
          if (previousWindow?.id && previousWindow.id !== tab.windowId) await chrome.windows.update(previousWindow.id, { focused: true });
        }
      } catch { /* A window may have closed during recovery. */ }
    }
  }
  // Restoring a minimized window can hide the page again. Verify that final state.
  if (playback.state === 'playing' && await ownedTab(session)) {
    playback = await probe(session, false, 'chzzk');
    if (!['playing', 'navigation'].includes(playback.state) && (await getSettings()).autoCollectChzzk) {
      playback = await probe(session, true, 'chzzk');
    }
  }
  session.diagnostic = { platform: 'chzzk', ...playback, recovery: 'foreground',
    focusedWindow: focusedForRecovery, checkedAt: Date.now() };
  return playback;
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
  // Stay on the current campaign while a broadcaster is available. A cooled-down
  // campaign must not block another active campaign from earning watch time.
  const campaign = [current, ...choices.filter(c => c !== current)].find(c =>
    c?.lives.some(l => (session?.cooldowns?.[l.key] || 0) <= now));
  if (!campaign) {
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
  if (state.soop) {
    await release(state.soop);
    delete state.soop;
    await persist(state);
  }
  const day = dropsDay();
  if (state.day && state.day !== day) {
    for (const platform of PLATFORMS) {
      const old = state[platform] || {};
      // Keep ownership of a still-open stream; never close a user-navigated tab.
      const tab = await ownedTab(old);
      state[platform] = (tab || await loadingOwnedTab(old)) ? { tabId: old.tabId, url: old.url, liveKey: old.liveKey,
        campaignId: old.campaignId, progressAt: Date.now() } : {};
    }
  }
  state.day = day;
  for (const platform of PLATFORMS) {
    let settings = await getSettings();
    let session = state[platform] || {};
    if (!settings[flag(platform)]) {
      await release(session);
      state[platform] = { status: '꺼짐', checkedAt: Date.now() };
      await persist(state); continue;
    }
    state[platform] = session;
    try {
      const selected = settings.chzzkCollectCampaign || 'auto';
      if (!session.userStopped && session.tabId && !await ownedTab(session)) {
        if (await loadingOwnedTab(session)) {
          session.status = '방송 페이지 다시 로딩 중 · 다음 확인에서 재생 상태 확인';
          session.checkedAt = Date.now(); await persist(state); continue;
        }
        session.userStopped = true;
      }
      const plan = platform === 'chzzk' ? await chzzkPlan(selected) :
        await twitchPlan(Date.now(), session.liveKey?.startsWith('twitch:') ? session.liveKey.slice(7) : null);
      delete session.account;
      session.campaigns = plan.campaigns.map(c => ({ id:c.id, title:c.title, completed:c.completed, active:c.active,
        minutes:c.minutes, earned:c.earned, total:c.total, endAt:c.endAt }));
      session.campaignsCheckedAt = Date.now();
      session.error = null;
      if (plan.catalog) session.catalog = plan.catalog;
      settings = await getSettings();
      if (!settings[flag(platform)]) { await release(session); state[platform] = { status: '꺼짐' }; await persist(state); continue; }
      if (platform === 'chzzk' && settings.chzzkCollectCampaign !== selected) continue;
      if (session.userStopped) {
        session.status = plan.campaigns.length && plan.campaigns.every(c => c.completed) ? '대상 캠페인 수령 완료 · 자동 시청 일시 중지됨' :
          '탭을 닫거나 이동하여 자동 시청 일시 중지됨 · 토글을 껐다 켜면 재개';
        session.checkedAt = Date.now(); await persist(state); continue;
      }
      const target = chooseTarget(plan, session, selected);
      if (!target) {
        await release(session); delete session.tabId; delete session.url;
        session.status = platform === 'twitch' && plan.needsClaim ? '시청 조건 달성 · 트위치 보상 수령 대기' :
          platform === 'twitch' && !plan.campaigns.length ? '이터널리턴 트위치 캠페인 대기 중' :
          plan.finished ? '대상 캠페인 완료·종료·보상 소진 · 자동 시청 대기' : '선택한 캠페인의 대상 방송 대기 중';
        session.checkedAt = Date.now(); await persist(state); continue;
      }
      const { campaign, live } = target;
      if (!validLiveUrl(live.url)) throw new Error('대상 방송 주소가 올바르지 않습니다.');
      let tab = await ownedTab(session);
      const patterns = platform === 'chzzk' ? ['https://chzzk.naver.com/live/*'] : ['https://www.twitch.tv/*', 'https://twitch.tv/*'];
      const others = (await chrome.tabs.query({ url: patterns })).filter(t => t.id !== tab?.id &&
        (platform !== 'twitch' || sameLiveUrl(t.pendingUrl || t.url, t.pendingUrl || t.url)));
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
        if (tab.mutedInfo?.muted !== true) tab = await chrome.tabs.update(session.tabId, { muted: true, autoDiscardable: false });
        playback = tab.discarded ? { state: 'discarded' } : await probe(session, false, platform);
        session.diagnostic = { platform, ...playback, attempt: 0, checkedAt: Date.now() };
        if (playback.state !== 'playing' && playback.state !== 'navigation' &&
            (tab.discarded || Date.now() - (session.lastStartAt || 0) >= 60000)) {
          if (!tab.discarded) {
            // A single background probe can miss a playing stream. Retry the
            // existing player without pulling the user's tab into focus.
            session.lastStartAt = Date.now();
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
      if (platform === 'chzzk' && !['playing', 'navigation', 'cancelled', 'interrupted', 'loading', 'discarded'].includes(playback.state)) {
        playback = await recoverChzzk(session, playback);
      }
      {
        if (playback.state === 'cancelled') { await release(session); state[platform] = { status: '꺼짐' }; await persist(state); continue; }
        if (playback.state === 'navigation') { session.userStopped = true; session.status = '방송 페이지 이동 감지 · 일시 중지'; }
        else if (playback.state === 'interrupted') {
          session.status = `${campaign.title} · 탭 전환 감지 · 다음 확인에서 재생 상태를 다시 확인합니다`;
        } else if (playback.state === 'loading' || playback.state === 'discarded') {
          session.status = `${campaign.title} · 방송 페이지 로딩 중 · 다음 확인에서 재생 재시도`;
        } else {
          const playing = playback.state === 'playing';
          session.failures = playing ? 0 : (session.failures || 0) + 1;
          const reason = playback.reason ? ` (${playback.reason})` : '';
          const detail = playback.state === 'missing' ? '플레이어 미감지 · 로그인/재생 화면 확인 필요'
            : playback.reason === 'BrowserGestureUnavailable' ? '브라우저 재생 권한 사용 실패 · 확장 권한/회사 정책 확인 필요'
            : playback.state === 'blocked' ? `재생 시작 차단${reason} · 다음 확인에서 재시도`
            : playback.state === 'injection_error' ? '플레이어 검사 실패 · 다음 확인에서 재시도'
            : '재생 재시도 중';
          session.status = `${campaign.title} · ${playing ? '재생 중' : detail}`;
          if (session.failures >= 3) {
            session.cooldowns ||= {}; session.cooldowns[live.key] = Date.now() + 10 * 60000;
            session.status = `재생 오류${reason} · 다음 확인에서 다른 대상 방송으로 전환`;
          }
        }
        if (!Number.isFinite(session.progressAt)) session.progressAt = Date.now();
        if (campaign.minutes !== null && campaign.minutes !== session.lastProgress) { session.lastProgress = campaign.minutes; session.progressAt = Date.now(); }
        if (campaign.minutes !== null) session.status += ` · 서버 시청 ${campaign.minutes}분 (${campaign.earned}/${campaign.total}개 달성)`;
        if (platform === 'twitch' && campaign.needsLink) session.status += ' · 게임 계정 연결 권장';
        if (Date.now() - session.progressAt > 10 * 60000) {
          session.status += ' · 적립 증가 미확인: 로그인/계정 연결/다른 시청 기기를 확인해 주세요';
          if (platform === 'twitch' && campaign.minutes !== null && playback.state === 'playing') {
            session.cooldowns ||= {};
            session.cooldowns[live.key] = Date.now() + 10 * 60000;
            session.status += ' · 다음 확인에서 다른 방송으로 전환';
          }
        }
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
  if (pending) return afterCurrent ? pending.catch(() => {}).then(() => checkCollector()) : pending;
  pending = run().finally(() => { pending = null; });
  return pending;
}
