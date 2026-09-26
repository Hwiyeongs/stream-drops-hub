import { dropsDay } from './drops-day.js';
import { getSettings } from './storage.js';
import { chzzkPlan, soopPlan } from './collector-plans.js';
import { validLiveUrl } from './live-monitor.js';

export const COLLECT_ALARM = 'collectEternalReturnDrops';
const flag = p => p === 'chzzk' ? 'autoCollectChzzk' : 'autoCollectSoop';
let pending;
export async function ensureCollectorAlarm() {
  const s = await getSettings();
  if (!s.autoCollectChzzk && !s.autoCollectSoop) { await chrome.alarms.clear(COLLECT_ALARM); return; }
  if ((await chrome.alarms.get(COLLECT_ALARM))?.periodInMinutes !== 1) await chrome.alarms.create(COLLECT_ALARM, { periodInMinutes: 1 });
}
// Executed only in an extension-created tab whose exact URL is still owned.
export async function controlVideo(expectedUrl, start = false) {
  if (location.href !== expectedUrl) return { state: 'navigation' };
  const videos = [...document.querySelectorAll('video')].filter(v => {
    const r = v.getBoundingClientRect(); return r.width > 120 && r.height > 80;
  }).sort((a,b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  const video = videos[0];
  if (!video) return { state: 'missing' };
  if (video.error) return { state: 'error' };
  if (start) video.muted = false;
  if (video.paused && !start) return { state: 'paused' };
  if (video.paused) {
    try { await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(Error('timeout')), 4000))]); }
    catch { return { state: 'blocked' }; }
  }
  const before = video.currentTime;
  await new Promise(resolve => setTimeout(resolve, 1500));
  if (location.href !== expectedUrl) return { state: 'navigation' };
  return { state: !video.paused && !video.ended && video.currentTime > before + 0.1 ? 'playing' : 'stalled' };
}
async function probe(session, start = false) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: session.tabId }, func: controlVideo, args: [session.url, start] });
    return results?.[0]?.result?.state || 'missing';
  } catch { return 'missing'; }
}
// Activate only for startup/recovery. Never take focus back after a user switches tabs.
async function startPlayback(session, platform, previousTab) {
  session.lastStartAt = Date.now();
  let playback = 'missing';
  const windowId = (await chrome.tabs.get(session.tabId)).windowId;
  try {
    await chrome.tabs.update(session.tabId, { active: true, muted: false });
    for (let attempt = 0; attempt < 8; attempt++) {
      const settings = await getSettings();
      if (!settings[flag(platform)]) return 'cancelled';
      const tab = await chrome.tabs.get(session.tabId);
      if ((tab.pendingUrl && tab.pendingUrl !== session.url) || (!tab.pendingUrl && tab.url !== session.url)) return 'navigation';
      if (!tab.active) return 'interrupted';
      if (tab.url === session.url && tab.status !== 'loading') {
        playback = await probe(session, true);
        if (playback === 'playing') {
          if (!await ownedTab(session)) return 'navigation';
          await chrome.tabs.update(session.tabId, { muted: true });
          return playback;
        }
        if (!['missing', 'stalled'].includes(playback)) return playback;
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
    return (tab.url === session.url || tab.pendingUrl === session.url) && (!tab.pendingUrl || tab.pendingUrl === session.url) ? tab : null;
  } catch { return null; }
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
      state[platform] = tab ? { tabId: old.tabId, url: old.url, liveKey: old.liveKey,
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
        tab = previous ? await chrome.tabs.update(tab.id, { url: live.url }) : await chrome.tabs.create({ url: live.url, active: false });
        Object.assign(session, { tabId: tab.id, url: live.url, liveKey: live.key, campaignId: campaign.id, title: campaign.title, openedAt: Date.now(), failures: 0, lastProgress: campaign.minutes, progressAt: Date.now() });
        await persist(state);
        playback = await startPlayback(session, platform, previousActive);
      } else {
        playback = await probe(session);
        if (playback !== 'playing' && playback !== 'navigation' && Date.now() - (session.lastStartAt || 0) >= 60000) {
          const [previousActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
          playback = await startPlayback(session, platform, previousActive);
        } else if (playback === 'playing' && await ownedTab(session)) {
          await chrome.tabs.update(session.tabId, { muted: true });
        }
      }
      {
        if (playback === 'cancelled') { await release(session); state[platform] = { status: '꺼짐' }; await persist(state); continue; }
        if (playback === 'navigation') { session.userStopped = true; session.status = '방송 페이지 이동 감지 · 일시 중지'; }
        else if (playback === 'blocked' || playback === 'missing') {
          session.status = `${campaign.title} · ${playback === 'blocked' ? '재생 버튼을 직접 눌러 주세요' : '플레이어 미감지 · 로그인/재생 화면 확인 필요'}`;
        } else {
          session.failures = playback === 'playing' ? 0 : (session.failures || 0) + 1;
          session.status = `${campaign.title} · ${playback === 'playing' ? '재생 중' : '재생 재시도 중'}`;
          if (session.failures >= 3) {
            session.cooldowns ||= {}; session.cooldowns[live.key] = Date.now() + 10 * 60000;
            session.status = '재생 오류 · 다음 확인에서 다른 대상 방송으로 전환';
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
