/** Inventory visibility depends only on the user's per-reward hide choices. */
export function isRewardVisible(drop, hidden = {}) {
  return !hidden[drop.id];
}
