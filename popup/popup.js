import { campaignDisplayDate } from '../src/services/campaign-date.js';
import { dropsDay } from '../src/services/drops-day.js';
import { request, fetchAllDrops, claimUnifiedDrop, saveSettings, recordHandledDrop } from '../src/services/client.js';
import { getCachedDrops, getHandledDropsLog, getSettings, getHiddenDrops, parseExpTimestamp, parseDropClaimExpiry, parseTimestamp, isRecentDate } from '../src/services/storage.js';
import { isRewardVisible } from '../src/services/reward-visibility.js';
import { getCollectorEvents, REASON_LABELS } from '../src/services/collector-diagnostics.js';
import { collectionProgressRows } from '../src/services/reward-progress.js';
import { renderCollectionProgress, setProgressTab } from './collection-progress.js';

const el = id => document.getElementById(id);
let settingsBusy = true;
const settingKeys = { settingNotify: 'enableNotifications', settingAutoClaim: 'autoClaim', settingInterval: 'pollingIntervalMinutes', settingLiveMonitor: 'liveMonitorEnabled', settingLiveAutoOpen: 'liveAutoOpen', settingCollectChzzk: 'autoCollectChzzk', settingCollectTwitch: 'autoCollectTwitch', settingCollectCampaign: 'chzzkCollectCampaign', settingCollectorAlerts: 'collectorFailureAlerts' };
const settingIds = Object.keys(settingKeys);
async function renderLiveStatus() {
  const [{ liveMonitorState: state }, settings] = await Promise.all([chrome.storage.local.get('liveMonitorState'), getSettings()]);
  el('liveMonitorStatus').textContent = !settings.liveMonitorEnabled ? '방송 감지 꺼짐' : ['chzzk', 'soop'].map(p => {
    const status = state?.platforms?.[p], name = p === 'chzzk' ? '치지직' : 'SOOP';
    return name + ': ' + (!status ? '확인 중…' : status.error || ('드롭스 방송 ' + status.count + '개 · ' + new Date(status.checkedAt).toLocaleTimeString('ko-KR') + (status.actionError ? '\n' + status.actionError : '')));
  }).join('\n');
}
async function renderCollector() {
  const [{ collectorState = {}, collectorCatalog = [], collectorCatalogCheckedAt, collectorCatalogPartial }, settings] = await Promise.all([chrome.storage.local.get(['collectorState', 'collectorCatalog', 'collectorCatalogCheckedAt', 'collectorCatalogPartial']), getSettings()]);
  const list = Number.isFinite(collectorCatalogCheckedAt) ? collectorCatalog : collectorState.chzzk?.catalog || collectorCatalog;
  el('refreshCampaigns').title = Number.isFinite(collectorCatalogCheckedAt) ?
    '목록 확인 ' + new Date(collectorCatalogCheckedAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' }) + (collectorCatalogPartial ? ' · 일부 조회 재시도 중' : '') : '캠페인 목록 새로고침';
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
let progressRenderRevision = 0;
async function renderProgressPanel() {
  const revision = ++progressRenderRevision;
  const [{ collectorState = {} }, settings] = await Promise.all([chrome.storage.local.get('collectorState'), getSettings()]);
  if (revision !== progressRenderRevision) return;
  renderCollectionProgress(el('collectionProgress'), collectionProgressRows(collectorState, settings), currentTab);
}
let catalogRefreshPending;
function refreshCatalog(force = false) {
  if (catalogRefreshPending) return catalogRefreshPending;
  catalogRefreshPending = (async () => {
    const { collectorCatalogCheckedAt: at, collectorCatalogPartial } = await chrome.storage.local.get(['collectorCatalogCheckedAt', 'collectorCatalogPartial']);
    if (!force && !collectorCatalogPartial && Number.isFinite(at) && at <= Date.now() && Date.now() - at < 60000) return;
    el('refreshCampaigns').disabled = true;
    try { await request('GET_COLLECTOR_CATALOG'); await renderCollector(); }
    finally { el('refreshCampaigns').disabled = false; }
  })().finally(() => { catalogRefreshPending = null; });
  return catalogRefreshPending;
}
let currentTab = 'all', drops = [], log = {}, hiddenDrops = {}, statuses = {}, batchJob = null;
const hideSelection = new Set();
let refreshing = false, claiming = false, renderRevision = 0, lastBatchNotice = null;
let toastTimer = null;
let historyExpiryTimer = null;
let dailySummaryTimer = null, dailySummaryRevision = 0;
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
  const expiry = parseDropClaimExpiry(drop);
  return !log[drop.id] && drop.claimable && (expiry === null || expiry >= Date.now()) && (drop.platform !== 'soop' || !drop.recentDate || isRecentDate(drop.recentDate));
}
function filteredDrops() { return currentTab === 'all' ? drops : drops.filter(d => d.platform === currentTab); }
function visibleHistory(now = Date.now()) {
  return Object.values(log).filter(drop => {
    const expiry = parseExpTimestamp(drop.expDate);
    return expiry === null || expiry >= now;
  });
}
function scheduleHistoryExpiry() {
  clearTimeout(historyExpiryTimer);
  const now = Date.now();
  const upcoming = Object.values(log).map(drop => parseExpTimestamp(drop.expDate)).filter(expiry => expiry !== null && expiry >= now);
  if (!upcoming.length) return;
  const next = upcoming.reduce((earliest, expiry) => Math.min(earliest, expiry), Infinity);
  historyExpiryTimer = setTimeout(() => { render(); scheduleHistoryExpiry(); }, Math.min(next - now + 1, 2147483647));
}
async function loadState() {
  const revision = ++renderRevision;
  const [cached, handled, state, hidden] = await Promise.all([getCachedDrops(), getHandledDropsLog(), chrome.storage.local.get('batchJob'), getHiddenDrops()]);
  if (revision !== renderRevision) return;
  log = handled;
  scheduleHistoryExpiry();
  hiddenDrops = hidden;
  drops = cached.drops.filter(drop => active(drop) && isRewardVisible(drop, hidden));
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
  if (el('hideRewardsDialog').open) renderHidePicker();
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
  setProgressTab(el('collectionProgress'), currentTab);
  el('rewardMenuBtn').classList.toggle('hidden', ['log', 'settings'].includes(currentTab));
  el('rewardMenuBtn').disabled = busy() || refreshing || !filteredDrops().length;
  for (const [id, platform] of [['badgeAll', null], ['badgeChzzk', 'chzzk'], ['badgeSoop', 'soop'], ['badgeTwitch', 'twitch']]) {
    el(id).textContent = platform ? drops.filter(d => d.platform === platform).length : drops.length;
  }
  const history = visibleHistory();
  el('badgeLog').textContent = history.length;
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
    el('logContainer').replaceChildren(...datedCards(history, true));
    el('logEmptyState').classList.toggle('hidden', history.length > 0);
    el('summaryText').textContent = `기록된 보상 ${history.length}개`;
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
function acquisitionTime(drop) {
  const value = drop.acquiredAt;
  // A calendar date alone does not prove that a reward was earned at midnight.
  const hasTime = typeof value === 'number' || (typeof value === 'string' && /[T\s]\d{1,2}:\d{2}/.test(value));
  const timestamp = hasTime ? parseTimestamp(value) : null;
  const date = timestamp !== null && timestamp > 0 ? new Date(timestamp) : null;
  if (!date || !Number.isFinite(date.getTime())) {
    const unknown = create('span', 'drop-acquired', '시간 미상');
    unknown.title = '획득 시각을 확인할 수 없습니다.';
    return unknown;
  }
  const observed = drop.acquisitionSource === 'observed';
  const options = { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const time = create('time', 'drop-acquired', '획득 ' + date.toLocaleTimeString('ko-KR', options));
  time.dateTime = date.toISOString();
  time.title = (observed ? '시청 조건 달성을 확인한 시각: ' : '획득 시각: ') +
    date.toLocaleString('ko-KR', { ...options, year: 'numeric', month: '2-digit', day: '2-digit' }) + ' (한국시간)';
  return time;
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
  title.appendChild(acquisitionTime(drop));
  sub.appendChild(create('span', 'drop-game', drop.gameTitle || drop.campaignName));
  if (history) sub.appendChild(create('span', 'action-badge', ({ copied: '코드 복사됨', saved: '코드 보관됨', claimed: '수령 완료' })[drop.actionType] || '기록됨'));
  if (drop.stale && !history) sub.appendChild(create('span', 'action-badge', '최신 조회 필요'));
  if (hidden) sub.appendChild(create('span', 'action-badge', '숨김'));
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
  if (hidden) {
    const button = create('button', 'btn-link reward-visibility-action', '숨김 해제');
    button.disabled = busy();
    button.addEventListener('click', () => restoreReward(drop));
    actions.appendChild(button);
  }
  const url = safeUrl(drop.campaignUrl);
  if (url) { const link = create('a', 'btn-link', '보관함 ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.appendChild(link); }
  node.appendChild(actions);
  return node;
}
async function restoreReward(drop) {
  if (busy()) return;
  claiming = true; render();
  try {
    await request('RESTORE_DROP', { id: drop.id });
    toast('보상 숨김을 해제했습니다.', 'success');
  } catch (error) { toast(error.message, 'error'); }
  finally { claiming = false; await loadState(); }
}
function updateHidePickerControls() {
  const items = filteredDrops();
  const selectedCount = items.filter(drop => hideSelection.has(drop.id)).length;
  const selectAll = el('hideRewardsSelectAll');
  selectAll.checked = items.length > 0 && selectedCount === items.length;
  selectAll.indeterminate = selectedCount > 0 && selectedCount < items.length;
  selectAll.disabled = busy() || !items.length;
  el('hideRewardsSelectionCount').textContent = `선택 ${selectedCount}/${items.length}개`;
  el('hideRewardsConfirm').disabled = busy() || !hideSelection.size;
  el('hideRewardsConfirm').textContent = claiming ? '숨기는 중…' : `숨기기${hideSelection.size ? ' (' + hideSelection.size + ')' : ''}`;
  el('hideRewardsCancel').disabled = busy();
}
function renderHidePicker() {
  const items = filteredDrops();
  const ids = new Set(items.map(drop => drop.id));
  for (const id of hideSelection) if (!ids.has(id)) hideSelection.delete(id);
  const rows = items.map(drop => {
    const row = create('label', 'reward-picker-row');
    const checkbox = create('input', ''); checkbox.type = 'checkbox'; checkbox.value = drop.id;
    checkbox.checked = hideSelection.has(drop.id); checkbox.disabled = busy();
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) hideSelection.add(drop.id); else hideSelection.delete(drop.id);
      updateHidePickerControls();
    });
    const imageUrl = safeUrl(drop.rewardImageUrl);
    const fallback = () => create('span', 'reward-picker-thumb reward-picker-thumb-fallback', '🎁');
    let thumbnail;
    if (imageUrl) {
      thumbnail = create('img', 'reward-picker-thumb'); thumbnail.src = imageUrl; thumbnail.alt = '';
      thumbnail.addEventListener('error', () => thumbnail.replaceWith(fallback()), { once: true });
    } else thumbnail = fallback();
    const details = create('span', 'drop-details'), title = create('span', 'drop-title-row');
    const platform = ['chzzk', 'soop', 'twitch'].includes(drop.platform) ? drop.platform : 'unknown';
    title.appendChild(create('span', `platform-pill pill-${platform}`, drop.platformName || drop.platform));
    const name = create('span', 'drop-name', drop.rewardName); name.title = drop.rewardName;
    title.appendChild(name); details.appendChild(title);
    const campaignName = drop.campaignName || drop.gameTitle || '';
    row.title = [drop.platformName || drop.platform, drop.rewardName, campaignName].filter(Boolean).join('\n');
    if (drop.platform === 'twitch' && campaignName && campaignName !== drop.rewardName) {
      details.appendChild(create('span', 'drop-game', campaignName));
    }
    row.append(checkbox, thumbnail, details); return row;
  });
  el('hideRewardsList').replaceChildren(...rows);
  el('hideRewardsEmpty').classList.toggle('hidden', items.length > 0);
  updateHidePickerControls();
}
async function hideSelectedRewards() {
  if (busy() || !hideSelection.size) return;
  const ids = [...hideSelection]; let success = 0; const errors = [];
  el('hideRewardsError').classList.add('hidden');
  claiming = true; render(); renderHidePicker();
  try {
    for (const id of ids) {
      try { await request('HIDE_DROP', { id }); success++; hideSelection.delete(id); }
      catch (error) { errors.push(error.message); }
    }
    if (!errors.length) el('hideRewardsDialog').close();
    else {
      el('hideRewardsError').textContent = `${success}개 숨김 · ${errors.length}개 실패: ${errors[0]}`;
      el('hideRewardsError').classList.remove('hidden');
    }
    toast(errors.length ? `${success}개 숨김 · ${errors.length}개 실패: ${errors[0]}` : `${success}개 보상을 숨겼습니다. 설정에서 다시 표시할 수 있습니다.`, errors.length ? 'warning' : 'success');
  } finally { claiming = false; await loadState(); }
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
async function renderDailySummary() {
  if (!el('dailySummaryDetails').open) return;
  const revision = ++dailySummaryRevision;
  const summary = await request('GET_DAILY_SUMMARY');
  if (revision !== dailySummaryRevision || !el('dailySummaryDetails').open) return;
  const table = create('table', 'daily-summary-table');
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  for (const label of ['플랫폼', '오늘 획득', '수령 대기']) {
    const cell = create('th', '', label); cell.scope = 'col'; header.appendChild(cell);
  }
  head.appendChild(header); table.appendChild(head);
  const body = document.createElement('tbody');
  for (const platform of ['chzzk', 'soop', 'twitch']) {
    const value = summary.platforms[platform];
    const row = create('tr', 'daily-summary-row'); row.dataset.platform = platform;
    const name = create('th', 'daily-summary-platform'); name.scope = 'row';
    name.appendChild(create('span', '', { chzzk: '치지직', soop: 'SOOP', twitch: '트위치' }[platform]));
    const status = { login: '로그인 필요', stale: '이전 조회 기준', unknown: '확인 전' }[value.state];
    if (status) name.appendChild(create('span', 'daily-summary-status', status));
    const earned = create('td', 'daily-summary-count', value.earnedToday === null ? '미확인' : value.earnedToday + '개');
    const pending = create('td', 'daily-summary-count', ['unknown', 'login'].includes(value.state) ? '미확인' : value.pending + '개');
    if (value.state === 'stale') pending.classList.add('daily-summary-stale');
    row.append(name, earned, pending); body.appendChild(row);
  }
  table.appendChild(body);
  el('dailySummaryContent').replaceChildren(table);
}
function scheduleDailySummaryReset() {
  clearTimeout(dailySummaryTimer);
  if (!el('dailySummaryDetails').open) return;
  const next = Date.parse(dropsDay() + 'T05:00:00+09:00') + 86400000;
  dailySummaryTimer = setTimeout(() => {
    void renderDailySummary().catch(error => toast(error.message, 'error'));
    scheduleDailySummaryReset();
  }, next - Date.now() + 1);
}
async function loadSettings() {
  const settings = await getSettings();
  el('settingCollectChzzk').checked = settings.autoCollectChzzk;
  el('settingCollectTwitch').checked = settings.autoCollectTwitch;
  await renderCollector();
  await renderProgressPanel();
  el('settingLiveMonitor').checked = settings.liveMonitorEnabled;
  el('settingLiveAutoOpen').checked = settings.liveAutoOpen;
  await renderLiveStatus();
  el('settingNotify').checked = settings.enableNotifications;
  el('settingAutoClaim').checked = settings.autoClaim;
  el('settingCollectorAlerts').checked = settings.collectorFailureAlerts;
  el('settingInterval').value = String(settings.pollingIntervalMinutes);
  enableSettingControls();
}
document.addEventListener('DOMContentLoaded', async () => {
  const settingControls = settingIds.map(el);
  settingControls.forEach(control => { control.disabled = true; });
  el('versionTag').textContent = 'v' + chrome.runtime.getManifest().version;
  el('rewardMenuBtn').addEventListener('click', () => {
    if (busy() || refreshing) return;
    hideSelection.clear(); el('hideRewardsError').classList.add('hidden'); renderHidePicker(); el('hideRewardsDialog').showModal();
  });
  el('hideRewardsSelectAll').addEventListener('change', () => {
    if (busy()) return;
    if (el('hideRewardsSelectAll').checked) {
      for (const drop of filteredDrops()) hideSelection.add(drop.id);
    } else hideSelection.clear();
    renderHidePicker();
  });
  el('hideRewardsCancel').addEventListener('click', () => el('hideRewardsDialog').close());
  el('hideRewardsConfirm').addEventListener('click', hideSelectedRewards);
  el('hideRewardsDialog').addEventListener('cancel', event => { if (busy()) event.preventDefault(); });
  el('hideRewardsDialog').addEventListener('close', () => hideSelection.clear());
  for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => {
    currentTab = tab.dataset.tab === 'settings' && currentTab === 'settings' ? 'all' : tab.dataset.tab;
    document.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === currentTab));
    el('settingsBtn').setAttribute('aria-pressed', String(currentTab === 'settings'));
    el('settingsBtn').title = currentTab === 'settings' ? '전체로 돌아가기' : '설정';
    el('settingsBtn').setAttribute('aria-label', el('settingsBtn').title);
    render();
    if (currentTab === 'settings') void refreshCatalog().catch(error => toast(error.message, 'error'));
  });
  el('refreshCampaigns').addEventListener('click', async () => {
    try { await refreshCatalog(true); } catch (error) { toast(error.message, 'error'); }
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
  el('dailySummaryDetails').addEventListener('toggle', () => {
    scheduleDailySummaryReset();
    void renderDailySummary().catch(error => toast(error.message, 'error'));
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
    if (changes.collectorState || changes.collectorCatalog || changes.collectorCatalogCheckedAt || changes.collectorCatalogPartial) void renderCollector().catch(console.error);
    if (changes.collectorState) void renderProgressPanel().catch(console.error);
    if (Object.keys(changes).some(k => ['dropsCache', 'platformStatuses', 'inventoryLastSuccess', 'inventoryAccounts', 'collectorState'].includes(k) || k.startsWith('handled:') || k.startsWith('hidden:') || k.startsWith('earned:twitch:'))) void renderDailySummary().catch(console.error);
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
    setInterval(() => { void renderProgressPanel().catch(console.error); }, 30000);
    try { await refresh(); } catch (error) { toast(error.message, 'error'); }
  }
});
