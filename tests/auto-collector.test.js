import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let data, tabs, actions, details, lives, claims, challenges, missions, soopLives, error, video, beforeFetch;
const channel = n => String(n).padStart(32,'a');
const live = (id, campaign, viewers=10) => ({liveId:id,dropsCampaignNo:campaign,liveCategory:'Black_Survival_Eternal_Return',concurrentUserCount:viewers,channel:{channelId:channel(id),channelName:'방송'+id}});
const detail = id => ({campaignNo:id,title:'캠페인'+id,categoryId:'Black_Survival_Eternal_Return',startDate:'2020-01-01 00:00:00',endDate:'2099-01-01 00:00:00',rewardList:[{rewardNo:id*10,conditionForMinutes:60,codeRemainingCount:10}]});
const event={addListener(){}};
globalThis.chrome={
 storage:{local:{async get(k){return k==null?structuredClone(data):Object.fromEntries((Array.isArray(k)?k:[k]).map(x=>[x,structuredClone(data[x])]));},async set(v){Object.assign(data,structuredClone(v));}}},
 alarms:{async get(){return null;},async create(n,v){data.alarm=v;},async clear(){delete data.alarm;}},
 tabs:{async get(id){const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t;},async query({url,active,windowId}){return tabs.filter(t=>(!url||(Array.isArray(url)?url:[url]).some(p=>t.url.startsWith(p.split('*')[0])))&&(active===undefined||t.active===active)&&(windowId===undefined||t.windowId===windowId));},async create(v){const t={id:Math.max(0,...tabs.map(t=>t.id))+1,windowId:1,...v};tabs.push(t);actions.push(['create',v]);return t;},async update(id,v){const t=tabs.find(t=>t.id===id);if(v.active)tabs.filter(x=>x.windowId===t.windowId).forEach(x=>x.active=false);Object.assign(t,v);actions.push(['update',v]);return t;},async remove(id){tabs=tabs.filter(t=>t.id!==id);actions.push(['remove',id]);}},
 scripting:{async executeScript(){actions.push(['play',video]);return [{result:{state:video}}];}},runtime:{getURL:p=>p},notifications:{async create(){}},
};
const {checkCollector,ensureCollectorAlarm,chooseTarget}=await import('../src/services/auto-collector.js');
const {campaignProgress,soopMissions}=await import('../src/services/collector-plans.js');
beforeEach(()=>{
 data={settings:{autoCollectChzzk:true,autoCollectSoop:false,chzzkCollectCampaign:'auto'}};tabs=[];actions=[];details=[detail(1),detail(2)];lives=[live(1,1),live(2,1),live(3,2)];claims=[];challenges=[];missions=[];soopLives=[];error=false;video='playing';beforeFetch=null;
 globalThis.fetch=async url=>{
   if(beforeFetch)await beforeFetch();if(error)throw Error('offline');
   let body;
   if(url.includes('/info'))body={code:200,content:{dropsCampaignList:details.map(d=>({campaignNo:d.campaignNo,title:d.title}))}};
   else if(url.includes('/drops/campaigns/'))body={code:200,content:details.find(d=>String(d.campaignNo)===url.split('/').at(-1))};
   else if(url.includes('/lives?'))body={code:200,content:{data:lives,page:{next:null}}};
   else if(url.endsWith('/claims'))body={code:200,content:{claimList:claims}};
   else if(url.endsWith('/challenges'))body={code:200,content:{challengeList:challenges}};
   else if(url.includes('get_drops_mission_list'))body={result:1,data:missions};
   else if(url.includes('sch.sooplive'))body={result:1,data:{list:soopLives,is_more:false}};
   else throw Error(url);
   return new Response(JSON.stringify(body));
 };
});
test('campaign-specific selection never opens another campaign',async()=>{data.settings.chzzkCollectCampaign='2';await checkCollector();assert.equal(data.collectorState.chzzk.campaignId,'2');assert.equal(tabs[0].url,'https://chzzk.naver.com/live/'+channel(3));});
test('offline broadcast switches within same campaign using one owned tab',async()=>{await checkCollector();const id=tabs[0].id;lives=[live(2,1),live(3,2,999)];await checkCollector();assert.equal(tabs.length,1);assert.equal(tabs[0].id,id);assert.equal(data.collectorState.chzzk.campaignId,'1');assert.equal(data.collectorState.chzzk.liveKey,'chzzk:2:1');});
test('completed campaign moves to next and closes own tab after all complete',async()=>{await checkCollector();claims=[{rewardNo:10}];await checkCollector();assert.equal(data.collectorState.chzzk.campaignId,'2');claims.push({rewardNo:20});await checkCollector();assert.equal(tabs.length,0);assert.match(data.collectorState.chzzk.status,/완료/);});
test('completion is not inferred from missing progress or watch timer',()=>{const c=campaignProgress(detail(1),[],[{rewardNo:10,accumWatchMinutes:60}]);assert.equal(c.completed,false);assert.equal(c.minutes,60);assert.equal(campaignProgress(detail(1),[],[]).completed,false);});
test('API failure preserves current tab and never declares complete',async()=>{await checkCollector();error=true;await checkCollector();assert.equal(tabs.length,1);assert.match(data.collectorState.chzzk.status,/실패/);});
test('turning off removes only owned tab',async()=>{await checkCollector();tabs.push({id:9,url:'https://example.com'});data.settings.autoCollectChzzk=false;await checkCollector();assert.deepEqual(tabs.map(t=>t.id),[9]);});
test('user closed or navigated tab pauses without reopening',async()=>{await checkCollector();tabs[0].url='https://example.com';await checkCollector();assert.equal(tabs.length,1);assert.equal(data.collectorState.chzzk.userStopped,true);data.settings.autoCollectChzzk=false;await checkCollector();assert.equal(tabs.length,1);});
test('other platform live tabs block concurrent viewing',async()=>{tabs=[{id:9,url:'https://chzzk.naver.com/live/'+channel(8)}];await checkCollector();assert.equal(actions.length,0);assert.match(data.collectorState.chzzk.status,/다른 방송 탭/);});
test('disable during fetch prevents opening',async()=>{beforeFetch=async()=>{data.settings.autoCollectChzzk=false;};await checkCollector();assert.equal(tabs.length,0);});
test('server progress is displayed separately from successful playback',async()=>{await checkCollector();challenges=[{rewardNo:10,accumWatchMinutes:12}];await checkCollector();assert.match(data.collectorState.chzzk.status,/서버 시청 12분/);assert.match(data.collectorState.chzzk.status,/재생 중/);});
test('autoplay denial requests interaction without tab thrashing',async()=>{await checkCollector();video='blocked';await checkCollector();await checkCollector();assert.equal(actions.filter(a=>a[0]==='create').length,1);assert.match(data.collectorState.chzzk.status,/직접/);});
test('three playback failures cool down failed broadcast and switch',async()=>{await checkCollector();video='stalled';await checkCollector();await checkCollector();await checkCollector();await checkCollector();assert.equal(data.collectorState.chzzk.liveKey,'chzzk:2:1');assert.equal(tabs.length,1);});
test('SOOP opens actual drops live then switches after ending',async()=>{data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];await checkCollector();assert.equal(tabs[0].url,'https://play.sooplive.com/first/1');soopLives=[{broad_no:2,broad_cate_no:'40120',is_drops:1,user_id:'second'}];await checkCollector();assert.equal(tabs.length,1);assert.equal(tabs[0].url,'https://play.sooplive.com/second/2');});
test('SOOP missions must match category, dates, and registered broadcaster',()=>{const rows=[{cateName:'이터널 리턴',title:'미션',dropsType:'B',startDate:'2020-01-01',endDate:'2099-01-01',itemList:[{percent:50,viewTime:30}],broadIdList:[{userId:'a',broadNo:1}]}];const r=soopMissions(rows,[{channelId:'a',liveId:'1'},{channelId:'b',liveId:'2'}]);assert.equal(r[0].lives.length,1);assert.equal(r[0].completed,false);rows[0].itemList[0].percent=100;assert.equal(soopMissions(rows,[])[0].completed,true);});
test('catalog choice persists when selected campaign temporarily has no live',async()=>{data.settings.chzzkCollectCampaign='2';lives=[live(1,1)];await checkCollector();assert.equal(tabs.length,0);assert.match(data.collectorState.chzzk.status,/대기/);});
test('one minute collection alarm and disabled cleanup',async()=>{await ensureCollectorAlarm();assert.equal(data.alarm.periodInMinutes,1);data.settings.autoCollectChzzk=false;await ensureCollectorAlarm();assert.equal(data.alarm,undefined);});

test('SOOP old missions do not block participation in todays events',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;
 missions=[{cateName:'이터널 리턴',title:'old',dropsType:'C',startDate:'2020-01-01',endDate:'2020-01-02',itemList:[{percent:100}]}];
 soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];
 await checkCollector();assert.equal(tabs.length,1);
});
test('OFF request during failed in-flight cycle still closes owned tab',async()=>{
 await checkCollector();let unblock,entered;const began=new Promise(r=>{entered=r;});const gate=new Promise(r=>{unblock=r;});
 beforeFetch=async()=>{entered();await gate;throw Error('network failure');};
 const active=checkCollector();await began;data.settings.autoCollectChzzk=false;
 const stopped=checkCollector(true);unblock();await active;await stopped;
 assert.equal(tabs.length,0);assert.equal(data.collectorState.chzzk.status,'꺼짐');
});
test('SOOP completed current mission closes owned stream',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;
 soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];
 missions=[{cateName:'이터널 리턴',title:'now',dropsType:'C',startDate:'2020-01-01',endDate:'2099-01-01',itemList:[{percent:50,viewTime:30}]}];
 await checkCollector();assert.equal(tabs.length,1);missions[0].itemList[0].percent=100;
 await checkCollector();assert.equal(tabs.length,0);
});

test('automatic viewing only reads progress and never saves coupons as handled',async()=>{
 claims=[{rewardNo:10,code:'DO-NOT-SAVE'}];
 await checkCollector();
 assert.equal(Object.keys(data).some(k=>k.startsWith('handled:') || k.startsWith('coupon:')),false);
 assert.equal(data.collectorState.chzzk.campaignId,'2');
});


test('startup activates then plays then mutes the tab and restores previous tab',async()=>{
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 await checkCollector();
 const play=actions.findIndex(a=>a[0]==='play');
 assert.ok(actions.slice(0,play).some(a=>a[0]==='update'&&a[1].active&&a[1].muted===false));
 assert.ok(actions.slice(play+1).some(a=>a[0]==='update'&&a[1].muted===true));
 assert.equal(tabs.find(t=>t.id===99).active,true);
 assert.equal(tabs.find(t=>t.id!==99).muted,true);
 actions=[];await checkCollector();
 assert.equal(actions.some(a=>a[0]==='update'&&a[1].active),false);
});

test('blocked playback is not marked muted successfully',async()=>{
 video='blocked';await checkCollector();
 assert.equal(actions.some(a=>a[0]==='update'&&a[1].muted===true),false);
 assert.match(data.collectorState.chzzk.status,/직접/);
});


test('manual tab switch during playback check is not reversed',async()=>{
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 tabs.push({id:98,windowId:1,url:'https://example.org',active:false});
 const original=chrome.scripting.executeScript;
 chrome.scripting.executeScript=async()=>{
   tabs.forEach(t=>t.active=t.id===98);
   return [{result:{state:'playing'}}];
 };
 try { await checkCollector();assert.equal(tabs.find(t=>t.id===98).active,true); }
 finally { chrome.scripting.executeScript=original; }
});


test('05:00 reset clears collection pause and cooldown while preserving records and owned tab',async()=>{
 const original=Date.now;let now=Date.parse('2026-09-22T04:59:00+09:00');Date.now=()=>now;
 try {
  data['coupon:keep']={code:'preserve'};
  await checkCollector();const id=tabs[0].id;
  Object.assign(data.collectorState.chzzk,{userStopped:true,failures:2,cooldowns:{'chzzk:1:1':now+86400000}});
  await checkCollector();assert.equal(data.collectorState.chzzk.userStopped,true);
  now=Date.parse('2026-09-22T05:00:00+09:00');await checkCollector();
  assert.equal(data.collectorState.chzzk.userStopped,undefined);
  assert.equal(data.collectorState.chzzk.cooldowns,undefined);
  assert.equal(tabs.length,1);assert.equal(tabs[0].id,id);
  assert.deepEqual(data['coupon:keep'],{code:'preserve'});
  assert.equal(data.settings.autoCollectSoop,false);
 } finally {Date.now=original;}
});
