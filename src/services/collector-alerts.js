import { getSettings } from './storage.js';
import { REASON_LABELS } from './collector-diagnostics.js';

const MINUTE = 60000;
const PLATFORMS = ['chzzk', 'twitch'];
const FLAGS = { chzzk: 'autoCollectChzzk', twitch: 'autoCollectTwitch' };
const NAMES = { chzzk: '치지직', twitch: '트위치' };
const LABELS = { query: '보관함 조회가 반복해서 실패했습니다.', playback: '방송 재생 복구가 반복해서 실패했습니다.', stalled: '서버 시청 시간 적립이 정체되어 있습니다.' };
function problem(state) {
  if (state.userStopped || ['off', 'paused'].includes(state.phase)) return null;
  if (state.phase === 'query_failed') return { kind: 'query', reason: Object.hasOwn(REASON_LABELS, state.queryReason) ? state.queryReason : null };
  if (['stalled_waiting', 'stalled_switch'].includes(state.phase)) return { kind: 'stalled', reason: null };
  if (['playback_retry', 'switch_pending'].includes(state.phase) &&
      !['interrupted', 'loading', 'navigation', 'cancelled'].includes(state.diagnostic?.state)) {
    return { kind: 'playback', reason: Object.hasOwn(REASON_LABELS, state.diagnostic?.reason) ? state.diagnostic.reason : null };
  }
  return null;
}
let tail = Promise.resolve();
/** Called after a completed collector cycle; alert errors must never stop collection. */
export function checkCollectorAlerts(now = Date.now()) {
  const task = tail.then(() => check(now));
  tail = task.catch(() => {});
  return task;
}
async function check(now) {
  const [settings, { collectorState = {}, collectorAlertState = {} }] = await Promise.all([
    getSettings(), chrome.storage.local.get(['collectorState', 'collectorAlertState']),
  ]);
  const next = {};
  if (settings.collectorFailureAlerts) for (const platform of PLATFORMS) {
    const state = collectorState[platform] || {};
    if (!settings[FLAGS[platform]] || state.userStopped || ['off', 'paused'].includes(state.phase)) continue;
    const previous = collectorAlertState[platform];
    const issue = problem(state);
    if (!issue) {
      // A successful query resolves query errors; waiting alone does not prove playback recovery.
      if (previous?.notified && previous.kind !== 'query' && !['playing', 'complete', 'waiting_claim'].includes(state.phase)) next[platform] = previous;
      continue;
    }
    const checkedAt = state.checkedAt;
    if (!Number.isFinite(checkedAt) || checkedAt > now || now - checkedAt > 3 * MINUTE) {
      if (previous?.notified) next[platform] = previous;
      continue;
    }
    if (previous?.notified) { next[platform] = previous; continue; }
    const continuous = previous?.kind === issue.kind && previous.reason === issue.reason &&
      Number.isFinite(previous.lastAt) && checkedAt >= previous.lastAt && checkedAt - previous.lastAt <= 3 * MINUTE;
    const entry = continuous ? { ...previous, lastAt: checkedAt,
      samples: previous.samples + (checkedAt > previous.lastAt ? 1 : 0) } :
      { ...issue, firstAt: checkedAt, lastAt: checkedAt, samples: 1, notified: false };
    next[platform] = entry;
    if (entry.samples < 3 || checkedAt - entry.firstAt < 2 * MINUTE) continue;
    const current = await getSettings();
    if (!current.collectorFailureAlerts || !current[FLAGS[platform]]) { delete next[platform]; continue; }
    try {
      await chrome.notifications.create('collector-issue:' + platform, {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: `[자동 수집 확인 필요] ${NAMES[platform]}`,
        message: LABELS[issue.kind] + (issue.reason ? ' ' + REASON_LABELS[issue.reason] + '.' : '') + ' 허브 설정의 수집 상태·진단을 확인해 주세요.',
      });
      entry.notified = true;
    } catch { /* Retry after the next confirmed sample if notifications are unavailable. */ }
  }
  await chrome.storage.local.set({ collectorAlertState: next });
}