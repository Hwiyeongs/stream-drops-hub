import { campaignDisplayDate } from '../src/services/campaign-date.js';
import { dropsDay } from '../src/services/drops-day.js';
import { request, fetchAllDrops, claimUnifiedDrop, saveSettings, recordHandledDrop } from '../src/services/client.js';
import { getCachedDrops, getHandledDropsLog, getSettings, getHiddenDrops, parseExpTimestamp, parseTimestamp, isRecentDate } from '../src/services/storage.js';
import { rewardGame, isRewardVisible } from '../src/services/reward-visibility.js';
import { getCollectorEvents, REASON_LABELS } from '../src/services/collector-diagnostics.js';

const el = id => document.getElementById(id);
let settingsBusy = true;
const settingKeys = { settingNotify: 'enableNotifications', settingAutoClaim: 'autoClaim', settingInterval: 'pollingIntervalMinutes', settingLiveMonitor: 'liveMonitorEnabled', settingLiveAutoOpen: 'liveAutoOpen', settingCollectChzzk: 'autoCollectChzzk', settingCollectTwitch: 'autoCollectTwitch', settingCollectCampaign: 'chzzkCollectCampaign', settingEternalOnly: 'eternalReturnOnly' };
const settingIds = Object.keys(settingKeys);
async function renderLiveStatus() {
  const [{ liveMonitorState: state }, settings] = await Promise.all([chrome.storage.local.get('liveMonitorState'), getSettings()]);
  el('liveMonitorStatus').textContent = !settings.liveMonitorEnabled ? '방송 감지 꺼짐' : ['chzzk', 'soop'].map(p => {
    const status = state?.platforms?.[p], name = p === 'chzzk' ? '치지직' : 'SOOP';
    return name + ': ' + (!status ? '확인 중…' : status.error || ('드롭스 방송 ' + status.count + '개 · ' + new Date(status.checkedAt).toLocaleTimeString('ko-KR') + (status.actionError ? '\n' + status.actionError : '')));
  }).join('\n');
}
async function renderCollector() {
  const [{ collectorState = {}, collectorCatalog = [] }, settings] = await Promise.all([chrome.storage.local.get(['collectorState', 'collectorCatalog']), getSettings()]);
  const list = collectorCatalog.length ? collectorCatalog : collectorState.chzzk?.catalog || [];
  const select = el('settingCollectCampaign');
  const options = [new Option('모든 캠페인 순차 수집', 'auto'), ...list.map(c => new Option(c.title, c.id))];
  if (settings.chzzkCollectCampaign !== 'auto' && !list.some(c => c.id === settings.chzzkCollectCampaign)) options.push(new Option('선택한 캠페인 #' + settings.chzzkCollectCampaign + ' (현재 목록 없음)', settings.chzzkCollectCampaign));
  select.replaceChildren(...options); select.value = settings.chzzkCollectCampaign;
  el('collectorStatus').textContent = ['chzzk', 'twitch'].map(p => {
    const on = p === 'chzzk' ? settings.autoCollectChzzk : settings.autoCollectTwitch;
    const state = collectorState[p];
    const fresh = Number.isFinite(state?.campaignsCheckedAt) && Date.now() - state.campaignsCheckedAt < 3 * 60000 &&
      dropsDay(state.campaignsCheckedAt) === dropsDay();
    const campaigns = on && fresh && !state?.error ? (state?.campaigns || []).filter(c => c.active && !c.completed) : [];
    const status = !on ? '꺼짐' : state?.error ? state.status : !fresh ?
      (state?.userStopped ? '자동 시청 일시 중지됨 · 보관함 재확인 대기' : '보관함 재확인 대기') : state?.status || '확인 중…';
    const today = p === 'twitch' && on && fresh && !state?.error && Number.isInteger(state.claimedToday) ?
      ` · 오늘 허브 수령 기록 ${state.claimedToday}개 (05시 기준)` : '';
    return (p === 'chzzk' ? '치지직: ' : '트위치: ') + status + today +
      campaigns.map(c => `\n· ${c.title}: ${c.earned}/${c.total}개 달성` +
        (p === 'twitch' && Number.isInteger(c.claimed) ? ` · 수령 완료 ${c.claimed}개 · 수령 대기 ${c.pending || 0}개` : '')).join('');
  }).join('\n');
}
function enableSettingControls() {
  settingIds.map(el).forEach(c => { c.disabled = settingsBusy; });
  el('settingLiveAutoOpen').disabled = settingsBusy || !el('settingLiveMonitor').checked;
}
let currentTab = 'all', drops = [], allDrops = [], log = {}, hiddenDrops = {}, viewSettings = {}, statuses = {}, batchJob = null;
let refreshing = false, claiming = false, renderRevision = 0, lastBatchNotice = null;
let toastTimer = null;
const create = (tag, className, text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
function toast(message, type = 'info') {
  const container = el('toastContainer');
  const node = container.firstElementChild || create('div', 'toast');
  node.className = `toast toast-${type}`;
  node.textContent = message;
  container.replaceChildren(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.remove();
    toastTimer = null;
  }, 5000);
}
function busy() { return claiming || batchJob?.status === 'running'; }
function active(drop) {
  const expiry = parseExpTimestamp(drop.expDate);
  return !log[drop.id] && drop.claimable && (expiry === null || expiry >= Date.now()) && (drop.platform !== 'soop' || !drop.recentDate || isRecentDate(drop.recentDate));
}
function filteredDrops() { return currentTab === 'all' ? drops : drops.filter(d => d.platform === currentTab); }
async function loadState() {
  const revision = ++renderRevision;
  const [cached, handled, state, hidden, settings] = await Promise.all([getCachedDrops(), getHandledDropsLog(), chrome.storage.local.get('batchJob'), getHiddenDrops(), getSettings()]);
  if (revision !== renderRevision) return;
  log = handled;
  hiddenDrops = hidden; viewSettings = settings;
  allDrops = cached.drops.filter(active);
  drops = allDrops.filter(drop => isRewardVisible(drop, settings, hidden));
  statuses = cached.platformStatuses;
  batchJob = state.batchJob;
  const partial = Object.values(statuses).some(s => s.error);
  el('lastUpdated').textContent = partial ? '일부 조회 실패 · 새로고침 가능' : cached.lastUpdated ? new Date(cached.lastUpdated).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) + ' 확인됨' : '확인 전';
  if (batchJob?.status === 'complete' && batchJob.id !== lastBatchNotice) {
    lastBatchNotice = batchJob.id;
    if (Date.now() - batchJob.finishedAt < 60000) toast(`전체 처리: ${batchJob.successCount}개 성공 / ${batchJob.errors.length}개 실패${batchJob.errors.length ? ' · 실패한 항목은 다시 시도할 수 있습니다.' : ' · 기록에 보관됨'}`, batchJob.errors.length ? 'warning' : 'success');
  }
  render();
  renderHiddenDrops();
}
function datedCards(items, history) {
    const receivedTime = d => parseTimestamp(history ? (d.receivedAt ?? d.handledAt) : (d.acquiredAt ?? d.recentDate ?? d.campaignDate ?? (d.platform === 'twitch' ? campaignDisplayDate(d.campaignName, d.expDate) : null))) || 0;
    const dateKey = d => receivedTime(d) ? new Date(receivedTime(d) + 9 * 3600000).toISOString().slice(0, 10) : '날짜 미상';
    const platformOrder = { chzzk: 0, soop: 1, twitch: 2 };
    const entries = [...items].sort((a, b) => {
      const ad = dateKey(a), bd = dateKey(b);
      if (ad !== bd) return ad === '날짜 미상' ? 1 : bd === '날짜 미상' ? -1 : bd.localeCompare(ad);
      return (platformOrder[a.platform] ?? 3) - (platformOrder[b.platform] ?? 3) || receivedTime(b) - receivedTime(a);
    });
    const nodes = [];
    let previousDate = null;
    for (const entry of entries) {
      const date = dateKey(entry);
      if (date !== previousDate) {
        nodes.push(create('div', 'history-date-divider', date === '날짜 미상' ? date : date.replaceAll('-', '. ') + '.'));
        previousDate = date;
      }
      nodes.push(card(entry, history));
    }
    return nodes;
}
function render() {
  el('rewardFilterBar').classList.toggle('hidden', ['log', 'settings'].includes(currentTab));
  el('rewardFilterState').textContent = viewSettings.eternalReturnOnly ? '이터널리턴만 표시 중' : '모든 게임 표시 중';
  const unknown = allDrops.filter(drop => !hiddenDrops[drop.id] && rewardGame(drop) === 'unknown').length;
  el('rewardFilterHint').textContent = viewSettings.eternalReturnOnly ?
    `다른 게임·분류 미확인 보상 제외${unknown ? ' · 분류 미확인 ' + unknown + '개' : ''}` : '';
  for (const [id, platform] of [['badgeAll', null], ['badgeChzzk', 'chzzk'], ['badgeSoop', 'soop'], ['badgeTwitch', 'twitch']]) {
    el(id).textContent = platform ? drops.filter(d => d.platform === platform).length : drops.length;
  }
  el('badgeLog').textContent = Object.keys(log).length;
  el('dropsListView').classList.toggle('hidden', ['log', 'settings'].includes(currentTab));
  el('logListView').classList.toggle('hidden', currentTab !== 'log');
  el('settingsView').classList.toggle('hidden', currentTab !== 'settings');
  const items = filteredDrops();
  el('claimAllBtn').classList.toggle('hidden', ['log', 'settings'].includes(currentTab) || items.length < 2);
  el('claimAllBtn').disabled = busy() || refreshing || !items.some(d => !d.stale);
  el('claimAllBtn').textContent = batchJob?.status === 'running' ? `처리 중 (${batchJob.remaining.length}개 남음)` : `전체 수령 (${items.filter(d => !d.stale).length})`;
  el('refreshBtn').disabled = refreshing || busy();
  el('refreshIcon').classList.toggle('rotating', refreshing);
  renderAlerts();
  if (currentTab === 'log') {
    const entries = Object.values(log);
    el('logContainer').replaceChildren(...datedCards(entries, true));
    el('logEmptyState').classList.toggle('hidden', entries.length > 0);
    el('summaryText').textContent = `기록된 보상 ${entries.length}개`;
  } else if (currentTab === 'settings') {
    el('summaryText').textContent = '설정';
  } else {
    el('dropsContainer').replaceChildren(...datedCards(items, false));
    el('emptyState').classList.toggle('hidden', items.length > 0);
    el('summaryText').textContent = batchJob?.status === 'running' ? `전체 처리 중 · ${batchJob.remaining.length}개 남음` : drops.length ? `수령 대기 중 ${drops.length}개` : Object.values(statuses).some(s => s.error) ? '조회 실패 · 위 안내를 확인해 주세요' : '수령 대기 0개';
  }
}
function renderAlerts() {
  const links = { chzzk: ['치지직', 'https://game.naver.com/profile#drops'], soop: ['SOOP', 'https://drops.sooplive.com/inventory'], twitch: ['트위치', 'https://www.twitch.tv/drops/inventory'] };
  el('loginAlertsContainer').replaceChildren();
  for (const [platform, status] of Object.entries(statuses)) {
    if (!status.error && status.loggedIn !== false) continue;
    const [name, url] = links[platform] || [platform, ''];
    const alert = create('div', 'login-alert');
    alert.appendChild(create('span', 'login-alert-text', `${name}: ${status.error || '로그인이 필요합니다.'}`));
    const link = create('a', 'login-link-btn', status.loggedIn === false ? '로그인 이동' : '보관함');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    alert.appendChild(link); el('loginAlertsContainer').appendChild(alert);
  }
}
function safeUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
function card(drop, history, hidden = false) {
  const node = create('div', history || hidden ? 'drop-card log-card' : 'drop-card claimable');
  const imageUrl = safeUrl(drop.rewardImageUrl);
  const fallback = () => create('div', 'drop-thumb-fallback', '🎁');
  if (imageUrl) {
    const image = create('img', 'drop-thumb'); image.src = imageUrl; image.alt = '보상';
    image.addEventListener('error', () => image.replaceWith(fallback()), { once: true });
    node.appendChild(image);
  } else node.appendChild(fallback());
  const details = create('div', 'drop-details'), title = create('div', 'drop-title-row'), sub = create('div', 'drop-sub-row');
  const platform = ['chzzk', 'twitch'].includes(drop.platform) ? drop.platform : 'unknown';
  title.appendChild(create('span', `platform-pill pill-${platform}`, drop.platformName || platform));
  const name = create('span', 'drop-name', drop.rewardName); name.title = drop.rewardName; title.appendChild(name);
  sub.appendChild(create('span', 'drop-game', drop.gameTitle || drop.campaignName));
  if (history) sub.appendChild(create('span', 'action-badge', ({ copied: '코드 복사됨', saved: '코드 보관됨', claimed: '수령 완료' })[drop.actionType] || '기록됨'));
  if (drop.stale && !history) sub.appendChild(create('span', 'action-badge', '최신 조회 필요'));
  if (hidden) sub.appendChild(create('span', 'action-badge', '숨김'));
  else if (!history && rewardGame(drop) === 'unknown') sub.appendChild(create('span', 'action-badge', '게임 분류 미확인'));
  if (drop.couponCode && !hidden) {
    const code = create('button', 'coupon-code-badge', drop.couponCode); code.title = '코드 복사';
    code.disabled = busy();
    code.addEventListener('click', () => copyCode(drop)); sub.appendChild(code);
  }
  if (history && drop.expDate) {
    const expiry = parseExpTimestamp(drop.expDate);
    sub.appendChild(create('span', 'exp-badge', expiry === null ? '만료일 확인 필요' : '만료: ' + new Date(expiry).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })));
  }
  details.append(title, sub); node.appendChild(details);
  const actions = create('div', 'drop-actions');
  if (!hidden && (!history || drop.couponCode)) {
    const coupon = drop.isCoupon || !!drop.couponCode;
    const button = create('button', coupon ? 'btn-claim btn-coupon' : 'btn-claim', drop.couponCode ? '코드 복사' : coupon ? '코드 확인' : '수령');
    button.disabled = busy() || (!history && drop.stale);
    button.addEventListener('click', () => drop.couponCode ? copyCode(drop) : claim(drop));
    actions.appendChild(button);
  }
  if (!history) {
    const button = create('button', 'btn-link reward-visibility-action', hidden ? '숨김 해제' : '숨기기');
    button.disabled = busy();
    button.addEventListener('click', () => setRewardHidden(drop, !hidden));
    actions.appendChild(button);
  }
  const url = safeUrl(drop.campaignUrl);
  if (url) { const link = create('a', 'btn-link', '보관함 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.appendChild(link); }
  node.appendChild(actions);
  return node;
}
async function setRewardHidden(drop, hidden) {
  if (busy()) return;
  claiming = true; render();
  try {
    await request(hidden ? 'HIDE_DROP' : 'RESTORE_DROP', { id: drop.id });
    toast(hidden ? '보상을 숨겼습니다. 설정에서 다시 표시할 수 있습니다.' :
      viewSettings.eternalReturnOnly && rewardGame(drop) !== 'eternal-return' ? '숨김을 해제했습니다. 전체 게임을 보려면 이터널리턴 필터를 꺼 주세요.' : '보상 숨김을 해제했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { claiming = false; await loadState(); }
}
function renderHiddenDrops() {
  const entries = Object.values(hiddenDrops).sort((a, b) => b.hiddenAt - a.hiddenAt);
  el('hiddenRewardsSummary').textContent = `숨긴 보상 ${entries.length}개`;
  el('hiddenRewardsContainer').replaceChildren(...entries.map(drop => card(drop, false, true)));
  el('hiddenRewardsEmpty').classList.toggle('hidden', entries.length > 0);
}
async function copyCode(drop) {
  if (busy()) return;
  claiming = true; render();
  try {
    await navigator.clipboard.writeText(drop.couponCode);
    await recordHandledDrop(drop, 'copied');
    toast('쿠폰 코드가 복사되었습니다.', 'success');
  } catch (error) { toast(`복사 또는 기록 저장 실패: ${error.message}`, 'error'); }
  finally { claiming = false; await loadState(); }
}
async function claim(drop) {
  if (busy()) return;
  claiming = true; render();
  try {
    const result = await claimUnifiedDrop(drop);
    if (result.itemCode) {
      try {
        await navigator.clipboard.writeText(result.itemCode);
        await recordHandledDrop(drop, 'copied');
        toast('쿠폰 코드를 복사하고 기록에 보관했습니다.', 'success');
      } catch { toast('쿠폰은 기록에 보관했습니다. 기록 탭에서 다시 복사해 주세요.', 'warning'); }
    } else toast('수령 완료 · 기록에 보관했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { claiming = false; await loadState(); }
}
async function refresh() {
  if (refreshing || busy()) return;
  refreshing = true; render();
  try { await fetchAllDrops(); } catch (error) { toast(`조회 실패: ${error.message}`, 'error'); }
  finally { refreshing = false; await loadState(); }
}
async function renderCollectorEvents() {
  const list = el('collectorRecentEvents');
  list.replaceChildren();
  const events = (await getCollectorEvents()).slice(-8).reverse();
  if (!events.length) { list.appendChild(create('li', '', '아직 기록된 동작이 없습니다.')); return; }
  for (const event of events) {
    const at = new Date(event.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const platform = { chzzk: '치지직', twitch: '트위치', system: '공통' }[event.platform];
    list.appendChild(create('li', '', `${at} · ${platform} · ${event.message}${event.campaign ? ' · ' + event.campaign : ''}${event.reason ? ' (' + REASON_LABELS[event.reason] + ')' : ''}`));
  }
}
async function loadSettings() {
  const settings = await getSettings();
  el('settingEternalOnly').checked = settings.eternalReturnOnly;
  el('settingCollectChzzk').checked = settings.autoCollectChzzk;
  el('settingCollectTwitch').checked = settings.autoCollectTwitch;
  await renderCollector();
  el('settingLiveMonitor').checked = settings.liveMonitorEnabled;
  el('settingLiveAutoOpen').checked = settings.liveAutoOpen;
  await renderLiveStatus();
  el('settingNotify').checked = settings.enableNotifications;
  el('settingAutoClaim').checked = settings.autoClaim;
  el('settingInterval').value = String(settings.pollingIntervalMinutes);
  enableSettingControls();
}
document.addEventListener('DOMContentLoaded', async () => {
  const settingControls = settingIds.map(el);
  settingControls.forEach(control => { control.disabled = true; });
  el('versionTag').textContent = 'v' + chrome.runtime.getManifest().version;
  for (const tab of document.querySelectorAll('.tab-btn')) tab.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(t => t.classList.toggle('active', t === tab));
    currentTab = tab.dataset.tab; render();
  });
  el('refreshCampaigns').addEventListener('click', async () => {
    el('refreshCampaigns').disabled = true;
    try { await request('GET_COLLECTOR_CATALOG'); await renderCollector(); } catch (error) { toast(error.message, 'error'); }
    finally { el('refreshCampaigns').disabled = false; }
  });
  el('refreshBtn').addEventListener('click', refresh);
  el('copyTwitchStatus').addEventListener('click', async () => {
    try {
      const report = await request('GET_TWITCH_STATUS_REPORT');
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast('트위치 상태 진단을 복사했습니다.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
  el('copyCollectorStatus').addEventListener('click', async () => {
    try {
      const report = await request('GET_COLLECTOR_STATUS_REPORT');
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast('치지직·트위치 자동 수집 진단을 복사했습니다.', 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
  el('collectorRecentDetails').addEventListener('toggle', () => {
    if (el('collectorRecentDetails').open) void renderCollectorEvents().catch(console.error);
  });
  el('claimAllBtn').addEventListener('click', async () => {
    if (busy()) return;
    claiming = true; render();
    try { batchJob = await request('CLAIM_ALL', { ids: filteredDrops().filter(d => !d.stale).map(d => d.id) }); }
    catch (error) { toast(error.message, 'error'); }
    finally { claiming = false; await loadState(); }
  });
  for (const id of settingIds) el(id).addEventListener('change', async () => {
    const value = id === 'settingInterval' ? Number(el(id).value) : id === 'settingCollectCampaign' ? el(id).value : el(id).checked;
    settingsBusy = true;
    enableSettingControls();
    try {
      await saveSettings({ [settingKeys[id]]: value });
      toast('설정과 확인 주기를 적용했습니다.', 'success');
    } catch (error) { toast(error.message, 'error'); }
    finally {
      settingsBusy = false;
      try { await Promise.all([loadSettings(), loadState()]); } catch (error) { toast(error.message, 'error'); }
      finally { enableSettingControls(); }
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some(k => k === 'dropsCache' || k === 'platformStatuses' || k === 'batchJob' || k.startsWith('handled:') || k.startsWith('hidden:'))) void loadState().catch(console.error);
    if (changes.collectorState || changes.collectorCatalog) void renderCollector().catch(console.error);
    if (changes.collectorEvents && el('collectorRecentDetails').open) void renderCollectorEvents().catch(console.error);
    if (changes.liveMonitorState) void renderLiveStatus().catch(console.error);
    if (changes.settings) { void loadSettings().catch(console.error); void loadState().catch(console.error); }
  });
  let initialized = false;
  try {
    await request('GET_STATE'); // Finish migration before rendering any old cache.
    await Promise.all([loadState(), loadSettings()]);
    initialized = true;
  } catch (error) { toast(error.message, 'error'); }
  finally { settingsBusy = false; enableSettingControls(); }
  if (initialized) {
    try { await refresh(); } catch (error) { toast(error.message, 'error'); }
  }
});
