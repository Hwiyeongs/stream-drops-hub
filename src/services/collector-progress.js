const STALL_MS = 10 * 60000, CONFIRM_MS = 2 * 60000, MAX_SAMPLE_GAP = 3 * 60000;

/** Server samples, not elapsed playback, decide whether CHZZK earning stalled. */
export function inspectChzzkProgress(session, campaign, playing, now = Date.now()) {
  const current = campaign.progressByReward || {};
  const known = Object.values(current).filter(value => Number.isFinite(value));
  const previous = session.lastRewardProgress || {};
  const changed = JSON.stringify(current) !== JSON.stringify(previous) || session.lastEarned !== campaign.earned;
  const continuous = Number.isFinite(session.lastProgressSampleAt) && now >= session.lastProgressSampleAt &&
    now - session.lastProgressSampleAt <= MAX_SAMPLE_GAP;
  session.lastRewardProgress = { ...current };
  session.lastEarned = campaign.earned;
  session.lastProgressSampleAt = now;
  // Missing samples, player recovery, clock changes and progress resets start a
  // fresh observation period. They cannot confirm that the server is stalled.
  if (!playing || !known.length || known.length !== Object.keys(current).length || changed || !continuous || !Number.isFinite(session.progressAt) || now < session.progressAt) {
    session.progressAt = now;
    delete session.stalledSince;
    return null;
  }
  if (now - session.progressAt < STALL_MS) { delete session.stalledSince; return null; }
  if (!Number.isFinite(session.stalledSince)) session.stalledSince = now;
  return now - session.stalledSince >= CONFIRM_MS ? 'confirmed' : 'recheck';
}

export function resetChzzkObservation(session, now = Date.now()) {
  session.progressAt = now;
  delete session.lastProgressSampleAt;
  delete session.stalledSince;
}
