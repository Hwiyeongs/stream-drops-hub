/** All popup writes and network operations run in the background worker. */
export async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.success) throw new Error(response?.error || '백그라운드 응답이 없습니다. 확장프로그램을 새로고침해 주세요.');
  return response.data;
}
export const fetchAllDrops = () => request('REFRESH_ALL');
export const claimUnifiedDrop = drop => request('CLAIM_DROP', { id: drop.id });
export const recordHandledDrop = (drop, actionType) => request('RECORD_COPIED', { id: drop.id, actionType });
export const saveSettings = settings => request('UPDATE_SETTINGS', { settings });
