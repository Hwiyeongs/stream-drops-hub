const ER_NAME = /^(이터널\s*리턴|eternal\s*return(?::?\s*black\s*survival)?)$/i;
/** Only official game metadata qualifies; campaign/reward titles are not game IDs. */
export function rewardGame(drop) {
  const category = drop?.gameCategoryId;
  if (category != null && String(category).trim()) {
    if (drop.platform === 'chzzk') return String(category) === 'Black_Survival_Eternal_Return' ? 'eternal-return' : 'other';
    if (drop.platform === 'soop' && /^\d+$/.test(String(category))) return Number(category) === 40120 ? 'eternal-return' : 'other';
  }
  if (drop?.gameSlug) return drop.gameSlug === 'eternal-return' ? 'eternal-return' : 'other';
  if (typeof drop?.officialGameName === 'string' && drop.officialGameName.trim()) {
    return ER_NAME.test(drop.officialGameName.trim()) ? 'eternal-return' : 'other';
  }
  return 'unknown';
}
export function isRewardVisible(drop, settings, hidden = {}) {
  return !hidden[drop.id] && (!settings.eternalReturnOnly || rewardGame(drop) === 'eternal-return');
}
