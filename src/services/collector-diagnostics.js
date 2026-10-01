const LIMIT = 100, RETENTION = 7 * 86400000;
const PLATFORMS = new Set(['chzzk', 'twitch', 'system']);
export const EVENT_LABELS = {
  reset: '05시 기준 일일 상태 초기화', off: '자동 수집 꺼짐', loading: '방송 페이지 로딩 중',
  paused: '탭 종료·이동으로 자동 시청 일시 중지', complete: '대상 캠페인 획득 완료',
  waiting_claim: '시청 조건 달성 · 트위치 수령 대기', waiting_live: '대상 방송 대기',
  waiting_other_tab: '다른 방송 탭으로 중복 시청 대기', playing: '방송 재생 확인',
  playback_retry: '재생 실패 · 복구 재시도', switch_pending: '재생 실패 · 방송 전환 예정',
  stalled_recheck: '적립 정체 · 서버 진행 재확인', stalled_switch: '적립 정체 확인 · 다른 방송으로 전환 예정',
  stalled_waiting: '적립 정체 확인 · 같은 캠페인 대체 방송 대기', query_failed: '조회·처리 실패',
  query_recovered: '조회·처리 정상화', stream_opened: '자동 시청 방송 열기', stream_switched: '자동 시청 방송 전환',
  progress: '서버 시청 시간 증가', earned: '새 드롭스 획득 확인', claimed: '보상 수령 확인', claim_failed: '보상 수령 실패 · 재시도 예정',
  coupon_saved: '쿠폰 코드를 기록에 보관', unknown: '상태 확인 대기',
};
const PLAYBACK = new Set(['playing', 'paused', 'blocked', 'stalled', 'missing', 'loading', 'discarded',
  'navigation', 'cancelled', 'interrupted', 'error', 'injection_error']);
export const REASON_LABELS = { NotAllowedError: '브라우저 자동재생 차단', AutoplayUnmutePaused: '플레이어 음소거 해제 후 재생 중지',
  BrowserGestureUnavailable: '브라우저 재생 권한 사용 불가', BrowserGestureFailed: '브라우저 재생 시작 실패',
  RecoveryFailure: '재생 복구 실패', AUTH_REQUIRED: '로그인·계정 연결 또는 인증 확인 필요', NETWORK_FAILURE: '서버 연결 실패',
  RESPONSE_FORMAT: '서버 응답 형식 확인 필요', HTTP_ERROR: '서버 요청 오류', UNKNOWN_ERROR: '원인을 확인할 수 없는 처리 오류' };
const REASONS = new Set(Object.keys(REASON_LABELS));
export function classifyCollectorError(error) {
  const message = String(error?.message || '');
  if (/로그인|계정 연결|인증|unauthori[sz]ed|integrity/i.test(message)) return 'AUTH_REQUIRED';
  if (/HTTP \d{3}/.test(message)) return 'HTTP_ERROR';
  if (/형식|일치하지|응답을 읽을|목록이 없습니다/.test(message)) return 'RESPONSE_FORMAT';
  if (/연결|시간.*초과|timeout|fetch|network|offline/i.test(message) || error?.name === 'AbortError') return 'NETWORK_FAILURE';
  return 'UNKNOWN_ERROR';
}
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const title = value => typeof value === 'string' ? value.slice(0, 160) : null;
function cleanEvent(event) {
  if (!event || !PLATFORMS.has(event.platform) || !Object.hasOwn(EVENT_LABELS, event.type) || finite(event.at) === null) return null;
  return { at: event.at, platform: event.platform, type: event.type, message: EVENT_LABELS[event.type],
    campaign: title(event.campaign), reason: REASONS.has(event.reason) ? event.reason : null,
    minutes: finite(event.minutes), earned: finite(event.earned), total: finite(event.total) };
}
function cleanEvents(events, now) {
  return (Array.isArray(events) ? events : []).map(cleanEvent).filter(event => event && event.at <= now && now - event.at <= RETENTION).slice(-LIMIT);
}
let eventTail = Promise.resolve();
/** All worker callers share this queue; failed diagnostic writes never stop collecting. */
export function appendCollectorEvent(platform, type, values = {}) {
  const task = eventTail.then(async () => {
    const now = Date.now();
    const event = cleanEvent({ at: now, platform, type, campaign: values.campaign,
      reason: values.reason, minutes: values.minutes, earned: values.earned, total: values.total });
    if (!event) return;
    const { collectorEvents } = await chrome.storage.local.get('collectorEvents');
    const events = cleanEvents(collectorEvents, now);
    events.push(event);
    await chrome.storage.local.set({ collectorEvents: events.slice(-LIMIT) });
  });
  eventTail = task.catch(() => {});
  return eventTail;
}
export async function getCollectorEvents(now = Date.now()) {
  await eventTail;
  const { collectorEvents } = await chrome.storage.local.get('collectorEvents');
  return cleanEvents(collectorEvents, now);
}

export async function logCollectorTransition(platform, before, after) {
  if (before.error && !after.error) await appendCollectorEvent(platform, 'query_recovered');
  if (after.tabId && (before.tabId !== after.tabId || before.url !== after.url || before.liveKey !== after.liveKey)) {
    await appendCollectorEvent(platform, before.tabId ? 'stream_switched' : 'stream_opened', { campaign: after.title });
  }
  const reason = after.phase === 'query_failed' ? after.queryReason : after.diagnostic?.reason;
  const previousReason = before.phase === 'query_failed' ? before.queryReason : before.diagnostic?.reason;
  if (after.phase && (after.phase !== before.phase || reason !== previousReason && ['query_failed', 'playback_retry'].includes(after.phase))) {
    await appendCollectorEvent(platform, after.phase, { campaign: after.title, reason });
  }
  const rewardIncreased = Object.entries(after.lastRewardProgress || {}).some(([id, value]) =>
    finite(value) !== null && finite(before.lastRewardProgress?.[id]) !== null && value > before.lastRewardProgress[id]);
  if (after.phase === 'playing' && before.campaignId === after.campaignId &&
      (rewardIncreased || finite(before.lastProgress) !== null && finite(after.lastProgress) !== null && after.lastProgress > before.lastProgress)) {
    await appendCollectorEvent(platform, 'progress', { campaign: after.title, minutes: after.lastProgress });
  }
  const previous = new Map((before.campaigns || []).map(c => [c.id, c]));
  for (const campaign of after.campaigns || []) {
    const old = previous.get(campaign.id);
    if (old && campaign.earned > old.earned) await appendCollectorEvent(platform, 'earned',
      { campaign: campaign.title, earned: campaign.earned, total: campaign.total });
  }
}

export async function getCollectorStatusReport(now = Date.now()) {
  const [{ collectorState = {}, settings = {} }, events] = await Promise.all([
    chrome.storage.local.get(['collectorState', 'settings']), getCollectorEvents(now),
  ]);
  const platforms = {};
  for (const platform of ['chzzk', 'twitch']) {
    const state = collectorState[platform] || {};
    const phase = Object.hasOwn(EVENT_LABELS, state.phase) ? state.phase : 'unknown';
    let tabOpen = false, tabOwned = false, tabMuted = null;
    if (state.tabId) {
      try {
        const tab = await chrome.tabs.get(state.tabId);
        tabOpen = true; tabOwned = !!state.url && ((!tab.pendingUrl && tab.url === state.url) || tab.pendingUrl === state.url);
        tabMuted = typeof tab.mutedInfo?.muted === 'boolean' ? tab.mutedInfo.muted : null;
      } catch { /* The tab may have closed while creating the report. */ }
    }
    platforms[platform] = { enabled: settings[platform === 'chzzk' ? 'autoCollectChzzk' : 'autoCollectTwitch'] === true,
      phase, status: EVENT_LABELS[phase], checkedAt: finite(state.checkedAt), campaignsCheckedAt: finite(state.campaignsCheckedAt),
      queryFailed: !!state.error, queryReason: state.error && REASONS.has(state.queryReason) ? state.queryReason : null,
      stale: !!state.error || !Number.isFinite(state.campaignsCheckedAt) || now - state.campaignsCheckedAt > 3 * 60000 || state.campaignsCheckedAt > now,
      tabOpen, tabOwned, tabMuted, userStopped: state.userStopped === true,
      progressObservationStartedAt: finite(state.progressAt), stalledSince: finite(state.stalledSince),
      playback: { state: PLAYBACK.has(state.diagnostic?.state) ? state.diagnostic.state : null,
        reason: REASONS.has(state.diagnostic?.reason) ? state.diagnostic.reason : null,
        checkedAt: finite(state.diagnostic?.checkedAt),
        recovery: ['foreground', 'background', 'background-check'].includes(state.diagnostic?.recovery) ? state.diagnostic.recovery : null },
      campaigns: (state.campaigns || []).map(c => ({ title: title(c.title), active: c.active === true, completed: c.completed === true,
        minutes: finite(c.minutes), earned: finite(c.earned), claimed: finite(c.claimed), pending: finite(c.pending), total: finite(c.total) })) };
  }
  return { version: chrome.runtime.getManifest().version, generatedAt: now, resetHourKst: 5,
    twitchAutoClaim: settings.autoClaim === true,
    inventoryIntervalMinutes: [5, 10, 15, 30].includes(settings.pollingIntervalMinutes) ? settings.pollingIntervalMinutes : 10,
    platforms, events };
}
