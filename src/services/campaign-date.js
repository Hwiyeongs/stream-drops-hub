import { parseTimestamp } from './storage.js';

const KST = 9 * 3600000;

export function timestampDisplayDate(value) {
  const time = parseTimestamp(value);
  return time === null ? null : new Date(time + KST).toISOString().slice(0, 10);
}

// A campaign label is a display date, not evidence of when a reward was earned.
export function campaignDisplayDate(name, endAt, now = Date.now()) {
  const match = String(name || '').match(/\[(\d{2})(\d{2})\]/);
  if (!match) return null;
  const anchor = parseTimestamp(endAt) ?? now;
  const year = new Date(anchor + 9 * 3600000).getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map(y => {
    const date = `${y}-${match[1]}-${match[2]}`;
    return { date, time: parseTimestamp(date) };
  }).filter(x => x.time !== null);
  candidates.sort((a, b) => Math.abs(a.time - anchor) - Math.abs(b.time - anchor));
  return candidates.length && Math.abs(candidates[0].time - anchor) <= 183 * 86400000 ? candidates[0].date : null;
}

// Twitch does not expose the actual earned/claimable timestamp in Inventory.
// Prefer an explicit MMDD label, then the individual drop start time, then campaign start.
export function twitchDisplayDate(name, dropStartAt, campaignStartAt, endAt, now = Date.now()) {
  return campaignDisplayDate(name, endAt ?? dropStartAt ?? campaignStartAt, now)
    ?? timestampDisplayDate(dropStartAt)
    ?? timestampDisplayDate(campaignStartAt);
}
