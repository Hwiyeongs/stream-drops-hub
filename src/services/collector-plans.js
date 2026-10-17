import { fetchWithTimeout } from './fetch-helper.js';
import { parseTimestamp } from './storage.js';
import { CHZZK_CATEGORY, fetchChzzkEternalLives } from './live-monitor.js';

const headers = { Accept: 'application/json', 'Front-Client-Product-Type': 'GAME', 'Front-Client-Platform-Type': 'PC' };
async function read(url, authenticated = false) {
  const response = await fetchWithTimeout(url, { credentials: authenticated ? 'include' : 'omit', headers, cache: 'no-store' }, 10000);
  if ([401, 403].includes(response.status)) throw new Error('로그인 또는 계정 연결을 확인해 주세요.');
  if (!response.ok) throw new Error(`조회 실패 (HTTP ${response.status})`);
  const json = await response.json();
  if (json.code != null && json.code !== 200) throw new Error(json.message || '조회에 실패했습니다.');
  return json;
}
async function readCategoryCatalog() {
  const json = await read(`https://api.chzzk.naver.com/service/v1/categories/GAME/${CHZZK_CATEGORY}/info`);
  if (!Array.isArray(json.content?.dropsCampaignList)) throw new Error('치지직 캠페인 목록 형식이 변경되었습니다.');
  return json.content.dropsCampaignList.filter(c => /^\d+$/.test(String(c.campaignNo))).map(c => ({ id: String(c.campaignNo), title: String(c.title || `캠페인 ${c.campaignNo}`) }));
}
async function readCampaign(id) {
  const { content } = await read(`https://api.chzzk.naver.com/service/v2/drops/campaigns/${id}`, true);
  if (String(content?.campaignNo) !== id || content.categoryId !== CHZZK_CATEGORY) throw new Error('치지직 캠페인 정보가 일치하지 않습니다.');
  return content;
}
let discoveryPending;
async function discoverCatalog() {
  const [category, broadcasts] = await Promise.allSettled([readCategoryCatalog(), fetchChzzkEternalLives()]);
  if (category.status === 'rejected' && broadcasts.status === 'rejected') throw category.reason;
  const lives = broadcasts.status === 'fulfilled' ? broadcasts.value : [];
  const entries = new Map((category.status === 'fulfilled' ? category.value : []).map(c => [c.id, c]));
  const missing = [...new Set(lives.map(l => String(l.campaignId)))].filter(id => !entries.has(id));
  const details = new Map(), failedIds = [];
  const results = await Promise.allSettled(missing.map(readCampaign));
  results.forEach((result, index) => {
    const id = missing[index];
    if (result.status === 'rejected') { failedIds.push(id); return; }
    details.set(id, result.value);
    entries.set(id, { id, title: String(result.value.title || `캠페인 ${id}`) });
  });
  if (category.status === 'rejected' && !entries.size) throw category.reason;
  const catalog = [...entries.values()], checkedAt = Date.now();
  // Both manual refresh and collection publish the same snapshot, including an
  // authoritative empty response. Share in-flight reads to prevent stale writes.
  await chrome.storage.local.set({ collectorCatalog: catalog, collectorCatalogCheckedAt: checkedAt,
    collectorCatalogPartial: category.status === 'rejected' || broadcasts.status === 'rejected' || failedIds.length > 0 });
  return { catalog, lives, details, failedIds, checkedAt,
    categoryFailed: category.status === 'rejected', livesError: broadcasts.status === 'rejected' ? broadcasts.reason : null };
}
function getDiscovery() {
  if (!discoveryPending) discoveryPending = discoverCatalog().finally(() => { discoveryPending = null; });
  return discoveryPending;
}
export async function fetchCampaignCatalog() { return (await getDiscovery()).catalog; }
export function campaignProgress(detail, claims, challenges, now = Date.now()) {
  if (!Array.isArray(detail?.rewardList) || !detail.rewardList.length) throw new Error('캠페인 보상 목록을 확인할 수 없습니다.');
  const earned = new Set(claims.map(r => String(r.rewardNo)));
  const rewards = detail.rewardList;
  const completed = rewards.every(r => earned.has(String(r.rewardNo)));
  const watchable = rewards.some(r => !earned.has(String(r.rewardNo)) &&
    !(r.codeRemainingCount != null && String(r.codeRemainingCount).trim() !== '' && Number(r.codeRemainingCount) === 0));
  const start = parseTimestamp(detail.startDate), end = parseTimestamp(detail.endDate);
  const active = start !== null && end !== null && start <= now && now < end && !detail.dropsCampaignNotStarted;
  const progress = challenges.filter(r => rewards.some(d => String(d.rewardNo) === String(r.rewardNo)));
  const minutes = progress.length ? Math.max(...progress.map(r => Number(r.accumWatchMinutes) || 0)) : null;
  const progressByReward = Object.fromEntries(rewards.filter(r => !earned.has(String(r.rewardNo))).map(reward => {
    const values = progress.filter(r => String(r.rewardNo) === String(reward.rewardNo))
      .map(r => r.accumWatchMinutes).filter(value => value != null && String(value).trim() !== '')
      .map(Number).filter(value => Number.isFinite(value) && value >= 0);
    return [String(reward.rewardNo), values.length ? Math.max(...values) : null];
  }));
  return { completed, active, watchable, minutes, earned: rewards.filter(r => earned.has(String(r.rewardNo))).length, total: rewards.length,
    progressByReward, rewardIds: rewards.map(r => String(r.rewardNo)), endAt: end, startDate: detail.startDate };
}
export async function chzzkPlan(selected = 'auto') {
  const [discovery, claimsJson, progressJson] = await Promise.all([
    getDiscovery(),
    read('https://api.chzzk.naver.com/commercial/v2/drops/rewards/claims', true),
    read('https://api.chzzk.naver.com/commercial/v2/drops/rewards/challenges', true),
  ]);
  if (discovery.livesError) throw discovery.livesError;
  const { catalog, lives, details } = discovery;
  if (!Array.isArray(claimsJson.content?.claimList) || !Array.isArray(progressJson.content?.challengeList)) throw new Error('치지직 로그인 및 보상 진행 정보를 확인해 주세요.');
  const chosen = catalog.filter(c => selected === 'auto' || c.id === selected);
  const results = await Promise.allSettled(chosen.map(async c => {
    const detail = details.get(c.id) || await readCampaign(c.id);
    return { ...c, ...campaignProgress(detail, claimsJson.content.claimList, progressJson.content.challengeList), lives: lives.filter(l => String(l.campaignId) === c.id) };
  }));
  const campaigns = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failedCampaignIds = [...new Set([...discovery.failedIds.filter(id => selected === 'auto' || id === selected),
    ...chosen.filter((_, index) => results[index].status === 'rejected').map(c => c.id)])];
  const retrying = discovery.categoryFailed || failedCampaignIds.length > 0;
  const pending = campaigns.filter(c => c.active && !c.completed && c.watchable).sort((a,b) => a.endAt - b.endAt || a.id.localeCompare(b.id));
  return { catalog, campaigns, candidates: pending, retrying, failedCampaignIds,
    finished: !retrying && campaigns.length > 0 && campaigns.every(c => c.completed || !c.active || !c.watchable) };
}
