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
export async function fetchCampaignCatalog() {
  const json = await read(`https://api.chzzk.naver.com/service/v1/categories/GAME/${CHZZK_CATEGORY}/info`);
  if (!Array.isArray(json.content?.dropsCampaignList)) throw new Error('치지직 캠페인 목록 형식이 변경되었습니다.');
  return json.content.dropsCampaignList.filter(c => /^\d+$/.test(String(c.campaignNo))).map(c => ({ id: String(c.campaignNo), title: String(c.title || `캠페인 ${c.campaignNo}`) }));
}
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
  return { completed, active, watchable, minutes, earned: rewards.filter(r => earned.has(String(r.rewardNo))).length, total: rewards.length,
    rewardIds: rewards.map(r => String(r.rewardNo)), endAt: end, startDate: detail.startDate };
}
export async function chzzkPlan(selected = 'auto') {
  const [catalog, lives, claimsJson, progressJson] = await Promise.all([
    fetchCampaignCatalog(), fetchChzzkEternalLives(),
    read('https://api.chzzk.naver.com/commercial/v2/drops/rewards/claims', true),
    read('https://api.chzzk.naver.com/commercial/v2/drops/rewards/challenges', true),
  ]);
  if (!Array.isArray(claimsJson.content?.claimList) || !Array.isArray(progressJson.content?.challengeList)) throw new Error('치지직 로그인 및 보상 진행 정보를 확인해 주세요.');
  const campaigns = await Promise.all(catalog.filter(c => selected === 'auto' || c.id === selected).map(async c => {
    const json = await read(`https://api.chzzk.naver.com/service/v2/drops/campaigns/${c.id}`, true);
    const detail = json.content;
    if (String(detail?.campaignNo) !== c.id || detail.categoryId !== CHZZK_CATEGORY) throw new Error('치지직 캠페인 정보가 일치하지 않습니다.');
    return { ...c, ...campaignProgress(detail, claimsJson.content.claimList, progressJson.content.challengeList), lives: lives.filter(l => String(l.campaignId) === c.id) };
  }));
  const pending = campaigns.filter(c => c.active && !c.completed && c.watchable).sort((a,b) => a.endAt - b.endAt || a.id.localeCompare(b.id));
  return { catalog, campaigns, candidates: pending, finished: campaigns.length > 0 && campaigns.every(c => c.completed || !c.active || !c.watchable) };
}
