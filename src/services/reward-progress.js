import { dropsDay } from './drops-day.js';

export function progressMinutes(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}
export function rewardProgress({ id, name, current, required, earned = false, claimed = false, exhausted = false }) {
  const currentMinutes = progressMinutes(current);
  const duration = progressMinutes(required), requiredMinutes = duration > 0 ? duration : null;
  const achieved = currentMinutes !== null && requiredMinutes !== null && currentMinutes >= requiredMinutes;
  const state = claimed ? 'claimed' : earned ? 'earned' : exhausted ? 'exhausted' : achieved ? 'achieved' :
    currentMinutes !== null && requiredMinutes !== null ? 'watching' : 'unknown';
  const percent = claimed || earned || achieved ? 100 : currentMinutes !== null && requiredMinutes !== null ?
    Math.min(99, Math.floor(currentMinutes / requiredMinutes * 100)) : null;
  return { id: String(id), name: String(name || '드롭스 보상'), currentMinutes, requiredMinutes, percent, state };
}
const achievedStates = new Set(['claimed', 'earned', 'achieved']);
export function progressLabel(reward) {
  return { claimed: '수령 완료', earned: '수령 대기', achieved: '시청 조건 달성', exhausted: '보상 소진', unknown: '확인 대기' }[reward.state] ||
    `${Math.floor(Math.min(reward.currentMinutes, reward.requiredMinutes))}/${Math.ceil(reward.requiredMinutes)}분`;
}
function openChzzkChannels(tabs, ownedId) {
  const channels = new Map();
  for (const tab of tabs) {
    if (tab.id === ownedId || tab.discarded) continue;
    try {
      const url = new URL(tab.pendingUrl || tab.url);
      const channel = /^\/live\/([a-f0-9]{32})\/?$/i.exec(url.pathname)?.[1]?.toLowerCase();
      if (url.protocol !== 'https:' || url.hostname !== 'chzzk.naver.com' || url.port || url.username || url.password || !channel) continue;
      channels.set(channel, !!tab.active || channels.get(channel) === true);
    } catch { /* A non-live tab cannot identify a Drops campaign. */ }
  }
  return channels;
}
export function collectionProgressRows(collectorState, settings, now = Date.now(), openTabs = []) {
  return ['chzzk', 'twitch'].filter(platform => settings[platform === 'chzzk' ? 'autoCollectChzzk' : 'autoCollectTwitch']).map(platform => {
    const session = collectorState[platform] || {};
    const matchesSelection = id => platform !== 'chzzk' || settings.chzzkCollectCampaign === 'auto' || !settings.chzzkCollectCampaign || String(id) === String(settings.chzzkCollectCampaign);
    const currentId = session.campaignId == null ? null : String(session.campaignId);
    const hasTarget = session.tabId != null && !session.userStopped && !['off', 'paused', 'complete', 'waiting_claim', 'waiting_live', 'waiting_other_tab'].includes(session.phase);
    const openedChannels = platform === 'chzzk' ? openChzzkChannels(openTabs, hasTarget ? session.tabId : null) : new Map();
    const campaigns = (session.progressCampaigns || session.campaigns || []).filter(c => c.active !== false && matchesSelection(c.id));
    if (hasTarget && currentId && matchesSelection(currentId) && session.title && !campaigns.some(c => String(c.id) === currentId)) {
      campaigns.push({ id: currentId, title: session.title, rewards: [], progressStale: true });
    }
    const incomplete = campaign => (campaign.rewards || []).some(r => !achievedStates.has(r.state) && r.state !== 'exhausted');
    const describe = item => {
      const checkedAt = item.progressCheckedAt ?? session.campaignsCheckedAt;
      const validTime = Number.isFinite(checkedAt) && checkedAt > 0 && checkedAt <= now;
      const stale = !!session.error || !!item.progressStale || !validTime || now - checkedAt >= 3 * 60000 || dropsDay(checkedAt) !== dropsDay(now);
      const channels = item.liveChannelIds || [];
      const opened = channels.some(channel => openedChannels.has(String(channel).toLowerCase()));
      const activeOpened = channels.some(channel => openedChannels.get(String(channel).toLowerCase()) === true);
      const collecting = hasTarget && String(item.id) === currentId;
      return { ...item, rewards: item.rewards || [], stale, checkedAt: validTime ? checkedAt : null,
        opened, activeOpened, collecting, sourceLabel: [opened ? '열린 방송' : '', collecting ? '자동 수집 대상' : ''].filter(Boolean).join(' · ') };
    };
    const described = campaigns.map(describe), recorded = described.find(c => String(c.id) === currentId);
    const current = described.find(c => c.activeOpened) || described.find(c => c.opened) ||
      (hasTarget ? recorded : null) || (recorded && incomplete(recorded) ? recorded : null) || described.find(incomplete) || recorded || described[0];
    described.sort((a, b) => (a === current ? 0 : a.collecting ? 1 : a.opened ? 2 : 3) - (b === current ? 0 : b.collecting ? 1 : b.opened ? 2 : 3));
    const rewards = current?.rewards || [];
    const remaining = rewards.filter(r => !achievedStates.has(r.state) && r.state !== 'exhausted');
    const next = remaining[0];
    const earned = rewards.filter(r => achievedStates.has(r.state)).length;
    const allEarned = rewards.length > 0 && earned === rewards.length;
    const percent = next ? next.percent : allEarned ? 100 : null;
    let status = session.userStopped || session.phase === 'paused' ? '일시 중지' :
      ({ query_failed: '조회 실패', waiting_live: '방송 대기', waiting_other_tab: '다른 방송 탭 확인 필요', loading: '재생 확인 중' }[session.phase] || '');
    if (current?.opened && !current.collecting && status && status !== '조회 실패') status = '자동 수집 ' + status;
    return { platform, name: platform === 'chzzk' ? '치지직' : '트위치', campaigns: described,
      campaignId: current?.id ?? null, sourceLabel: current?.sourceLabel || '', title: current?.title || '캠페인 확인 대기', percent, next, earned, total: rewards.length,
      label: next ? progressLabel(next) : allEarned ? rewards.every(r => r.state === 'claimed') ? '수령 완료' : '시청 조건 달성' :
        rewards.some(r => r.state === 'exhausted') ? '남은 보상 소진' : '확인 대기',
      stale: current?.stale ?? false, checkedAt: current?.checkedAt ?? null, status,
      partial: !!session.catalogRetrying || described.some(c => c.progressStale) };
  });
}
