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
 tabs:{async get(id){const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t;},async query({url,active,windowId}){return tabs.filter(t=>(!url||(Array.isArray(url)?url:[url]).some(p=>t.url.startsWith(p.split('*')[0])))&&(active===undefined||t.active===active)&&(windowId===undefined||t.windowId===windowId));},async create(v){const t={id:Math.max(0,...tabs.map(t=>t.id))+1,windowId:1,...v};tabs.push(t);actions.push(['create',v]);return t;},async update(id,v){const t=tabs.find(t=>t.id===id);if(v.active)tabs.filter(x=>x.windowId===t.windowId).forEach(x=>x.active=false);Object.assign(t,v);if(v.active&&t.discarded){t.discarded=false;t.status='complete';}actions.push(['update',v]);return t;},async remove(id){tabs=tabs.filter(t=>t.id!==id);actions.push(['remove',id]);}},
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
test('autoplay denial remains retryable without tab thrashing',async()=>{await checkCollector();video='blocked';await checkCollector();await checkCollector();assert.equal(actions.filter(a=>a[0]==='create').length,1);assert.match(data.collectorState.chzzk.status,/재시도/);});
test('three playback failures cool down failed broadcast and switch',async()=>{await checkCollector();video='stalled';await checkCollector();await checkCollector();await checkCollector();await checkCollector();assert.equal(data.collectorState.chzzk.liveKey,'chzzk:2:1');assert.equal(tabs.length,1);});
test('SOOP opens actual drops live then switches after ending',async()=>{data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];await checkCollector();assert.equal(tabs[0].url,'https://play.sooplive.com/first/1');soopLives=[{broad_no:2,broad_cate_no:'40120',is_drops:1,user_id:'second'}];await checkCollector();assert.equal(tabs.length,1);assert.equal(tabs[0].url,'https://play.sooplive.com/second/2');});
test('SOOP recovers an existing stream in the background without stealing focus',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;
 soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 await checkCollector();
 data.collectorState.soop.lastStartAt=Date.now()-60001;
 actions=[];
 const original=chrome.scripting.executeScript;
 let checks=0;
 chrome.scripting.executeScript=async ({args})=>[{result:{state:++checks%2?'stalled':'playing',deltaSeconds:checks%2?0:2,muted:true}}];
 try {
  await checkCollector();
  assert.equal(checks,2);
  assert.equal(data.collectorState.soop.diagnostic.recovery,'background');
  assert.match(data.collectorState.soop.status,/재생 중/);
  assert.equal(actions.some(a=>a[0]==='update'&&a[1].active===true),false);
  assert.equal(tabs.find(t=>t.id===99).active,true);
 } finally {chrome.scripting.executeScript=original;}
});
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


test('startup activates muted tab, plays, and restores previous tab',async()=>{
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 await checkCollector();
 const play=actions.findIndex(a=>a[0]==='play');
 assert.equal(actions.find(a=>a[0]==='create')[1].url,'about:blank');
 const navigate=actions.findIndex(a=>a[0]==='update'&&a[1].url?.startsWith('https://chzzk.naver.com/live/'));
 assert.ok(actions.slice(0,navigate).some(a=>a[0]==='update'&&a[1].muted===true));
 assert.ok(actions.slice(0,play).some(a=>a[0]==='update'&&a[1].active&&a[1].muted===true));
 assert.equal(actions.some(a=>a[0]==='update'&&a[1].muted===false),false);
 assert.equal(tabs.find(t=>t.id===99).active,true);
 assert.equal(tabs.find(t=>t.id!==99).muted,true);
 actions=[];await checkCollector();
 assert.equal(actions.some(a=>a[0]==='update'&&a[1].active),false);
});

test('blocked playback keeps the tab muted for safe retries',async()=>{
 video='blocked';await checkCollector();
 assert.equal(tabs[0].muted,true);
 assert.match(data.collectorState.chzzk.status,/재시도/);
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


test('controlVideo mutes the media element before the first play',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://chzzk.naver.com/live/'+channel(1);
 const media={paused:true,ended:false,muted:false,defaultMuted:false,currentTime:0,readyState:4,networkState:1,
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  async play(){assert.equal(this.muted,true);assert.equal(this.defaultMuted,true);this.paused=false;setTimeout(()=>{this.currentTime=1;},50);}};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media]};
 try {const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);assert.equal(r.state,'playing');assert.equal(r.muted,true);assert.ok(r.deltaSeconds>0);}
 finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});

test('SOOP starts its live stream through the site play button, not the initial placeholder',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://play.sooplive.com/tester/1';
 let startedAt=0,clicks=0;
 const media={paused:true,ended:false,muted:false,defaultMuted:false,readyState:4,networkState:2,
  currentSrc:'data:video/mp4;base64,placeholder',get currentTime(){return startedAt ? (Date.now()-startedAt)/1000 : 0.12;},
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  play(){throw Error('The placeholder must not be played directly');}};
 const button={click(){clicks++;assert.equal(media.muted,true);media.currentSrc='blob:https://play.sooplive.com/live';media.paused=false;startedAt=Date.now();}};
 globalThis.location={href:url};
 globalThis.document={querySelectorAll:()=>[media],querySelector:selector=>selector==='video#livePlayer'?media:selector==='button#play.play'?button:null};
 try {const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true,'soop');assert.equal(r.state,'playing');assert.equal(r.muted,true);assert.equal(clicks,1);assert.ok(r.deltaSeconds>2);}
 finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});

test('NotAllowedError is recorded without storing the exception message',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://play.sooplive.com/tester/1';
 const media={paused:true,ended:false,muted:false,defaultMuted:false,currentTime:0,readyState:2,networkState:1,
  getBoundingClientRect(){return {width:0,height:0};},
  play(){assert.equal(this.muted,true);return Promise.reject(Object.assign(Error('private URL or cookie must not be stored'),{name:'NotAllowedError'}));}};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media]};
 try {const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);assert.equal(r.state,'blocked');assert.equal(r.reason,'NotAllowedError');assert.equal(JSON.stringify(r).includes('private URL'),false);}
 finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});

test('resolved play without currentTime progress remains stalled',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://play.sooplive.com/tester/1';
 const media={paused:true,ended:false,muted:false,defaultMuted:false,currentTime:0,readyState:2,networkState:1,
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  async play(){this.paused=false;}};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media]};
 try {const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);assert.equal(r.state,'stalled');assert.equal(r.deltaSeconds,0);}
 finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});

test('muted playback retries NotAllowedError and records the successful attempt',async()=>{
 const original=chrome.scripting.executeScript;let attempts=0;
 chrome.scripting.executeScript=async()=>[{result:++attempts===1?{state:'blocked',reason:'NotAllowedError',muted:true}:{state:'playing',muted:true,deltaSeconds:1}}];
 try {await checkCollector();assert.equal(attempts,2);assert.equal(data.collectorState.chzzk.diagnostic.attempt,2);assert.equal(data.collectorState.chzzk.diagnostic.state,'playing');assert.equal(tabs[0].muted,true);}
 finally {chrome.scripting.executeScript=original;}
});

test('only collector-owned tabs are protected from automatic discard',async()=>{
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 await checkCollector();
 assert.equal(tabs.find(t=>t.id!==99).autoDiscardable,false);
 assert.equal(tabs.find(t=>t.id===99).autoDiscardable,undefined);
 tabs.find(t=>t.id!==99).discarded=true;
 await checkCollector();
 assert.equal(data.collectorState.chzzk.diagnostic.state,'playing');
 assert.equal(tabs.find(t=>t.id!==99).discarded,false);
 assert.equal(tabs.find(t=>t.id===99).autoDiscardable,undefined);
});

test('scripting injection failure has its own retryable diagnosis',async()=>{
 const original=chrome.scripting.executeScript;
 chrome.scripting.executeScript=async()=>{throw Error('private tab URL must not be stored');};
 try {await checkCollector();assert.equal(data.collectorState.chzzk.diagnostic.state,'injection_error');assert.equal(data.collectorState.chzzk.diagnostic.reason,'ScriptingFailure');assert.equal(JSON.stringify(data.collectorState).includes('private tab URL'),false);}
 finally {chrome.scripting.executeScript=original;}
});


test('new muted tab waits through the about:blank navigation transition',async()=>{
 const original=chrome.tabs.get;let matchingReads=0;
 chrome.tabs.get=async id=>{
  const tab=await original(id);
  if(tab.url?.startsWith('https://chzzk.naver.com/live/')&&++matchingReads===2)
   return {...tab,url:'about:blank',pendingUrl:undefined,status:'loading'};
  return tab;
 };
 try {await checkCollector();assert.equal(data.collectorState.chzzk.userStopped,undefined);assert.match(data.collectorState.chzzk.status,/재생 중/);}
 finally {chrome.tabs.get=original;}
});

test('SOOP reload transition does not permanently pause an owned tab',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;
 soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];
 await checkCollector();
 const owned=tabs[0];
 owned.url='about:blank';owned.status='loading';
 data.collectorState.day='2020-01-01';
 await checkCollector();
 assert.equal(data.collectorState.soop.userStopped,undefined);
 assert.equal(data.collectorState.soop.tabId,owned.id);
 assert.match(data.collectorState.soop.status,/다시 로딩 중/);
 owned.url='https://play.sooplive.com/first/1';owned.status='complete';
 await checkCollector();
 assert.equal(data.collectorState.soop.userStopped,undefined);
 assert.equal(data.collectorState.soop.diagnostic.state,'playing');
});

test('SOOP navigation to another pending address still pauses collection',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;
 soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];
 await checkCollector();
 Object.assign(tabs[0],{url:'about:blank',pendingUrl:'https://example.com/',status:'loading'});
 await checkCollector();
 assert.equal(data.collectorState.soop.userStopped,true);
 assert.match(data.collectorState.soop.status,/일시 중지/);
});
