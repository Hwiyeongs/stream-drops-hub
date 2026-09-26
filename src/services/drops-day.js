// Korea 05:00 is UTC 20:00 on the preceding calendar date.
export function dropsDay(now = Date.now()) {
  return new Date(now + 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
