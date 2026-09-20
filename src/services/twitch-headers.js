const STORAGE_KEY = 'twitchGqlHeaders';
const MAX_AGE_MS = 30 * 60 * 1000;
const FORWARDED = new Set([
  'authorization',
  'client-id',
  'client-integrity',
  'client-session-id',
  'client-version',
  'device-id',
  'x-device-id',
  'accept-language',
]);

let registered = false;
let memoryCapture = null;

function lowerKeys(headers) {
  return new Set(Object.keys(headers || {}).map(key => key.toLowerCase()));
}

export function pickTwitchGqlHeaders(requestHeaders) {
  const headers = {};
  for (const header of requestHeaders || []) {
    if (typeof header?.name !== 'string' || typeof header?.value !== 'string' || !header.value) continue;
    if (FORWARDED.has(header.name.toLowerCase())) headers[header.name] = header.value;
  }
  return headers;
}

export function isUsableTwitchGqlHeaders(capture, now = Date.now()) {
  if (!capture?.headers || !capture.at || now - capture.at > MAX_AGE_MS) return false;
  const keys = lowerKeys(capture.headers);
  return keys.has('authorization') && keys.has('client-integrity');
}

async function persistCapture(capture) {
  memoryCapture = capture;
  try {
    if (chrome.storage?.session) await chrome.storage.session.set({ [STORAGE_KEY]: capture });
  } catch (error) {
    console.warn('[Twitch] Could not persist captured GQL headers for this browser session:', error);
  }
}

export function registerTwitchHeaderCapture() {
  if (registered || !chrome.webRequest?.onSendHeaders) return false;
  registered = true;
  chrome.webRequest.onSendHeaders.addListener(
    details => {
      // Only harvest requests made by a real Twitch tab. Extension/background requests use tabId -1.
      if (details.method !== 'POST' || !(details.tabId >= 0)) return;
      const headers = pickTwitchGqlHeaders(details.requestHeaders);
      const capture = { headers, at: Date.now(), tabId: details.tabId };
      if (!isUsableTwitchGqlHeaders(capture)) return;
      void persistCapture(capture);
    },
    { urls: ['https://gql.twitch.tv/*'] },
    ['requestHeaders', 'extraHeaders']
  );
  return true;
}

export async function getCapturedTwitchGqlHeaders() {
  if (isUsableTwitchGqlHeaders(memoryCapture)) return memoryCapture;
  try {
    if (chrome.storage?.session) {
      const capture = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
      if (isUsableTwitchGqlHeaders(capture)) {
        memoryCapture = capture;
        return capture;
      }
    }
  } catch (error) {
    console.warn('[Twitch] Could not read captured GQL headers:', error);
  }
  return null;
}

export async function clearCapturedTwitchGqlHeaders() {
  memoryCapture = null;
  try {
    if (chrome.storage?.session) await chrome.storage.session.remove(STORAGE_KEY);
  } catch {}
}

export async function waitForCapturedTwitchGqlHeaders({ newerThan = 0, timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = await getCapturedTwitchGqlHeaders();
    if (capture && capture.at > newerThan) return capture;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

export function buildCapturedTwitchRequestHeaders(capture) {
  return { ...(capture?.headers || {}), 'Content-Type': 'application/json' };
}
