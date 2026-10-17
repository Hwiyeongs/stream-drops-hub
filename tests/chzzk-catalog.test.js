import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chzzkPlan, fetchCampaignCatalog } from '../src/services/collector-plans.js';
import { getSettings } from '../src/services/storage.js';
import { dropsDay } from '../src/services/drops-day.js';
let data, category, liveIds, details, broken, categoryError, livesError, authError, reads;
const detail = id => ({ campaignNo: id, title: 'Campaign ' + id, categoryId: 'Black_Survival_Eternal_Return',
  startDate: '2020-01-01', endDate: '2099-01-01', rewardList: [{ rewardNo: id * 10, conditionForMinutes: 60, codeRemainingCount: 10 }] });
globalThis.chrome = { storage: { local: {
  async get(keys) { return keys == null ? structuredClone(data) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
  async set(values) { Object.assign(data, structuredClone(values)); },
} } };
beforeEach(() => {
  data = { settings: { chzzkCollectCampaign: 'auto' } }; category = [1]; liveIds = [1];
  details = new Map([[1, detail(1)], [2, detail(2)]]); broken = new Set();
  categoryError = livesError = authError = false; reads = { catalog: 0, lives: 0, details: [] };
  globalThis.fetch = async (url, options) => {
    let content;
    if (url.endsWith('/info')) {
      reads.catalog++; assert.equal(options.cache, 'no-store');
      if (categoryError) throw Error('offline');
      content = { dropsCampaignList: category.map(id => ({ campaignNo: id, title: 'Campaign ' + id })) };
    } else if (url.includes('/lives?')) {
      reads.lives++; if (livesError) throw Error('offline');
      content = { data: liveIds.map(id => ({ liveId: id, dropsCampaignNo: id, liveCategory: 'Black_Survival_Eternal_Return',
        channel: { channelId: String(id).padStart(32, 'a'), channelName: 'Fixture' } })), page: { next: null } };
    } else if (url.includes('/drops/campaigns/')) {
      const id = Number(url.split('/').at(-1)); reads.details.push(id);
      if (broken.has(id)) return new Response('{}', { status: 404 });
      content = details.get(id);
    } else if (url.endsWith('/claims')) {
      if (authError) return new Response('{}', { status: 401 });
      content = { claimList: [] };
    } else if (url.endsWith('/challenges')) content = { challengeList: [] };
    else throw Error('Unexpected fixture URL');
    return new Response(JSON.stringify({ code: 200, content }));
  };
});
const popup = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
const renderSource = popup.slice(popup.indexOf('async function renderCollector()'), popup.indexOf('function enableSettingControls()'));
async function selector() {
  const nodes = { settingCollectCampaign: { replaceChildren(...options) { this.options = options; } }, collectorStatus: {}, refreshCampaigns: {} };
  class Option { constructor(title, value) { this.title = title; this.value = value; } }
  await new Function('chrome', 'getSettings', 'el', 'Option', 'dropsDay', renderSource + '\nreturn renderCollector();')(
    chrome, getSettings, id => nodes[id], Option, dropsDay);
  return nodes.settingCollectCampaign.options.map(option => option.value);
}
test('automatic plans publish newly listed campaigns to the same catalog used by settings', async () => {
  await chzzkPlan(); category.push(2); liveIds.push(2);
  const plan = await chzzkPlan();
  assert.deepEqual(plan.candidates.map(c => c.id), ['1', '2']);
  assert.deepEqual(data.collectorCatalog.map(c => c.id), ['1', '2']);
  assert.ok(data.collectorCatalogCheckedAt > 0); assert.equal(data.collectorCatalogPartial, false);
  assert.deepEqual(await selector(), ['auto', '1', '2']);
});
test('settings prefer the latest shared catalog over old collector state', async () => {
  data.collectorState = { chzzk: { catalog: [{ id: 'old', title: 'Old' }] } };
  await chzzkPlan(); assert.deepEqual(await selector(), ['auto', '1']);
});
test('legacy manual cache cannot hide a newer collector catalog before the first shared refresh', async () => {
  data.collectorCatalog = [{ id: '1' }]; data.collectorState = { chzzk: { catalog: [{ id: '1' }, { id: '2' }] } };
  assert.deepEqual(await selector(), ['auto', '1', '2']);
});
test('a successful empty catalog removes old options instead of falling back to stale collector data', async () => {
  data.collectorState = { chzzk: { catalog: [{ id: 'old' }] } }; category = []; liveIds = [];
  await fetchCampaignCatalog(); assert.deepEqual(data.collectorCatalog, []);
  assert.deepEqual(await selector(), ['auto']);
});
test('a drops-marked live missing from the category list is verified and discovered without manual refresh', async () => {
  liveIds = [1, 2]; const plan = await chzzkPlan();
  assert.deepEqual(plan.candidates.map(c => c.id), ['1', '2']);
  assert.equal(data.collectorCatalog.find(c => c.id === '2').title, 'Campaign 2');
  assert.equal(reads.details.filter(id => id === 2).length, 1);
});
test('a failed category list falls back to verified live campaign details and remains marked incomplete', async () => {
  categoryError = true; liveIds = [2]; const plan = await chzzkPlan();
  assert.deepEqual(plan.candidates.map(c => c.id), ['2']); assert.equal(plan.retrying, true);
  assert.equal(plan.finished, false); assert.equal(data.collectorCatalogPartial, true);
});
test('both discovery sources failing preserves the previous shared catalog and timestamp', async () => {
  data.collectorCatalog = [{ id: 'keep' }]; data.collectorCatalogCheckedAt = 123;
  categoryError = livesError = true; await assert.rejects(fetchCampaignCatalog());
  assert.deepEqual(data.collectorCatalog, [{ id: 'keep' }]); assert.equal(data.collectorCatalogCheckedAt, 123);
});
test('category failure without a verified fallback cannot overwrite the catalog with an assumed empty result', async () => {
  data.collectorCatalog = [{ id: 'keep' }]; data.collectorCatalogCheckedAt = 123;
  categoryError = true; liveIds = []; await assert.rejects(fetchCampaignCatalog());
  assert.deepEqual(data.collectorCatalog, [{ id: 'keep' }]); assert.equal(data.collectorCatalogCheckedAt, 123);
});
test('one broken campaign does not block a valid campaign or establish total completion', async () => {
  category = liveIds = [1, 2]; broken.add(1); const plan = await chzzkPlan();
  assert.deepEqual(plan.candidates.map(c => c.id), ['2']); assert.deepEqual(plan.failedCampaignIds, ['1']);
  assert.equal(plan.retrying, true); assert.equal(plan.finished, false);
});
test('all broken campaign details produce a retryable plan, not a completed plan', async () => {
  broken.add(1); const plan = await chzzkPlan();
  assert.deepEqual(plan.candidates, []); assert.equal(plan.retrying, true); assert.equal(plan.finished, false);
});
test('a fallback from another category is never displayed or watched as an Eternal Return campaign', async () => {
  category = []; liveIds = [2]; details.get(2).categoryId = 'Other_Game';
  const plan = await chzzkPlan(); assert.deepEqual(plan.catalog, []); assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.failedCampaignIds, ['2']); assert.equal(plan.finished, false);
});
test('malformed fallback rewards cannot become a watchable campaign', async () => {
  category = []; liveIds = [2]; details.get(2).rewardList = [];
  const plan = await chzzkPlan(); assert.deepEqual(plan.candidates, []); assert.equal(plan.retrying, true);
});
test('a missing selected campaign cannot silently switch to a newly discovered campaign', async () => {
  category = [1]; liveIds = [2]; const plan = await chzzkPlan('1');
  assert.deepEqual(plan.campaigns.map(c => c.id), ['1']); assert.deepEqual(plan.catalog.map(c => c.id), ['1', '2']);
});
test('failed discovery of an unrelated live does not mark a specifically selected valid campaign as failed', async () => {
  liveIds = [1, 2]; broken.add(2); const plan = await chzzkPlan('1');
  assert.deepEqual(plan.candidates.map(c => c.id), ['1']); assert.equal(plan.retrying, false);
});
test('claims authentication errors still reject collection instead of being treated as no earned rewards', async () => {
  authError = true; await assert.rejects(chzzkPlan(), /로그인/);
  // Discovery may finish independently after the failed authenticated read.
  await fetchCampaignCatalog();
});
test('a live-list failure rejects collection while a successful category snapshot can still update settings', async () => {
  livesError = true; await assert.rejects(chzzkPlan());
  assert.deepEqual(data.collectorCatalog.map(c => c.id), ['1']); assert.equal(data.collectorCatalogPartial, true);
});
test('concurrent manual and automatic refresh share one discovery request and one committed snapshot', async () => {
  const [catalog, plan] = await Promise.all([fetchCampaignCatalog(), chzzkPlan()]);
  assert.equal(reads.catalog, 1); assert.equal(reads.lives, 1); assert.deepEqual(catalog, plan.catalog);
});
