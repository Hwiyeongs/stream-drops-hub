import { getSettings, getHiddenDrops, validateSettingsValues } from './storage.js';

export const BACKUP_MAX_BYTES = 1024 * 1024;
const SCHEMA = 'StreamDropsHubSettings';
const TOP_FIELDS = new Set(['schema', 'schemaVersion', 'exportedAt', 'extensionVersion', 'settings', 'hiddenRewards']);
const HIDDEN_FIELDS = new Set(['id', 'platform', 'hiddenAt', 'platformName', 'rewardName', 'gameTitle', 'campaignName', 'rewardImageUrl']);
const META = ['platformName', 'rewardName', 'gameTitle', 'campaignName'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function hiddenReward(value, strict = true) {
  if (!plain(value) || !['chzzk', 'soop', 'twitch'].includes(value.platform) ||
      typeof value.id !== 'string' || value.id.length > 2048 || !value.id.startsWith(value.platform + '_') ||
      value.id.length === value.platform.length + 1 || /[\x00-\x1f]/.test(value.id)) throw new Error('숨김 보상 형식이 올바르지 않습니다.');
  if (strict && Object.keys(value).some(key => !HIDDEN_FIELDS.has(key))) throw new Error('지원하지 않는 숨김 보상 항목이 있습니다.');
  const result = { id: value.id, platform: value.platform };
  if (value.hiddenAt != null) {
    if (!Number.isFinite(value.hiddenAt) || value.hiddenAt <= 0) throw new Error('숨김 날짜가 올바르지 않습니다.');
    result.hiddenAt = value.hiddenAt;
  }
  for (const field of META) if (value[field] != null) {
    if (typeof value[field] !== 'string' || value[field].length > 512) throw new Error('숨김 보상 설명이 올바르지 않습니다.');
    result[field] = value[field];
  }
  if (value.rewardImageUrl != null) {
    let url;
    try {
      if (typeof value.rewardImageUrl !== 'string' || value.rewardImageUrl.length > 4096) throw Error();
      url = new URL(value.rewardImageUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw Error();
      result.rewardImageUrl = url.href;
    } catch {
      if (strict) throw new Error('보상 이미지 주소가 올바르지 않습니다.');
      // An unsafe old optional thumbnail cannot block exporting otherwise valid preferences.
    }
  }
  return result;
}
export function validateSettingsBackup(value) {
  if (!plain(value) || value.schema !== SCHEMA || value.schemaVersion !== 1) throw new Error('지원하는 드롭스 허브 설정 백업이 아닙니다.');
  if (Object.keys(value).some(key => !TOP_FIELDS.has(key))) throw new Error('지원하지 않는 백업 항목이 있습니다.');
  if (typeof value.extensionVersion !== 'string' || value.extensionVersion.length > 64 ||
      typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt))) throw new Error('백업 정보가 올바르지 않습니다.');
  if (!plain(value.settings)) throw new Error('백업 설정이 올바르지 않습니다.');
  const settings = validateSettingsValues(value.settings, true);
  if (!Object.keys(settings).length) throw new Error('복원할 설정이 없습니다.');
  if (!Array.isArray(value.hiddenRewards) || value.hiddenRewards.length > 2000) throw new Error('숨김 보상 목록이 올바르지 않습니다.');
  const hiddenRewards = [...new Map(value.hiddenRewards.map(entry => { const clean = hiddenReward(entry); return [clean.id, clean]; })).values()];
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BACKUP_MAX_BYTES) throw new Error('백업 파일은 1MB 이하만 사용할 수 있습니다.');
  return { schema: SCHEMA, schemaVersion: 1, exportedAt: value.exportedAt, extensionVersion: value.extensionVersion, settings, hiddenRewards };
}
export function parseSettingsBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > BACKUP_MAX_BYTES) throw new Error('백업 파일은 1MB 이하만 사용할 수 있습니다.');
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('백업 파일을 읽을 수 없습니다. JSON 파일을 선택해 주세요.'); }
  return validateSettingsBackup(value);
}
export async function createSettingsBackup() {
  const [settings, hidden] = await Promise.all([getSettings(), getHiddenDrops()]);
  return validateSettingsBackup({ schema: SCHEMA, schemaVersion: 1, exportedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version,
    settings: validateSettingsValues(settings), hiddenRewards: Object.values(hidden).map(entry => hiddenReward(entry, false)) });
}
export async function restoreSettingsBackup(value) {
  // Validate the complete document before writing any settings or visibility preferences.
  const backup = validateSettingsBackup(value);
  const [current, hidden] = await Promise.all([getSettings(), getHiddenDrops()]);
  const additions = backup.hiddenRewards.filter(entry => !Object.hasOwn(hidden, entry.id));
  const changes = Object.fromEntries(additions.map(entry => ['hidden:' + entry.id, { ...entry, hiddenAt: entry.hiddenAt ?? Date.now() }]));
  const settings = { ...current, ...backup.settings };
  await chrome.storage.local.set({ ...changes, settings });
  return { settings, settingsCount: Object.keys(backup.settings).length, hiddenAdded: additions.length, hiddenTotal: Object.keys(hidden).length + additions.length };
}