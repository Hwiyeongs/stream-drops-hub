import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let data, tabs, actions, details, lives, claims, challenges, missions, soopLives, twitchLives, twitchClaimed, error, video, beforeFetch;
const channel = n => String(n).padStart(32,'a');
const live = (id, campaign, viewers=10) => ({liveId:id,dropsCampaignNo:campaign,liveCategory:'Black_Survival_Eternal_Return',concurrentUserCount:viewers,channel:{channelId:channel(id),channelName:'방송'+id}});
const detail = id => ({campaignNo:id,title:'캠페인'+id,categoryId:'Black_Survival_Eternal_Return',startDate:'2020-01-01 00:00:00',endDate:'2099-01-01 00:00:00',rewardList:[{rewardNo:id*10,conditionForMinutes:60,codeRemainingCount:10}]});
const event={addListener(){}};
globalThis.chrome={
 storage:{local:{async get(k){return k==null?structuredClone(data):Object.fromEntries((Array.isArray(k)?k:[k]).map(x=>[x,structuredClone(data[x])]));},async set(v){Object.assign(data,structuredClone(v));}}},
 alarms:{async get(){return null;},async create(n,v){data.alarm=v;},async clear(){delete data.alarm;}},
 tabs:{async get(id){const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return t;},async query({url,active,windowId}){return tabs.filter(t=>(!url||(Array.isArray(url)?url:[url]).some(p=>t.url.startsWith(p.split('*')[0])))&&(active===undefined||t.active===active)&&(windowId===undefined||t.windowId===windowId));},async create(v){const t={id:Math.max(0,...tabs.map(t=>t.id))+1,windowId:1,...v};tabs.push(t);actions.push(['create',v]);return t;},async update(id,v){const t=tabs.find(t=>t.id===id);if(v.active)tabs.filter(x=>x.windowId===t.windowId).forEach(x=>x.active=false);Object.assign(t,v);if('muted' in v)t.mutedInfo={muted:v.muted,reason:'extension'};if(v.active&&t.discarded){t.discarded=false;t.status='complete';}actions.push(['update',v]);return t;},async remove(id){tabs=tabs.filter(t=>t.id!==id);actions.push(['remove',id]);}},
 scripting:{async executeScript(){actions.push(['play',video]);return [{result:{state:video}}];}},runtime:{getURL:p=>p},notifications:{async create(){}},
};
chrome.storage.session={async get(){return {twitchGqlHeaders:{at:Date.now(),headers:{Authorization:'OAuth test','Client-Integrity':'test'}}};},async remove(){}};
const {checkCollector,ensureCollectorAlarm,chooseTarget}=await import('../src/services/auto-collector.js');
const {campaignProgress,soopMissions}=await import('../src/services/collector-plans.js');
beforeEach(()=>{
 data={settings:{autoCollectChzzk:true,autoCollectSoop:false,chzzkCollectCampaign:'auto'}};tabs=[];actions=[];details=[detail(1),detail(2)];lives=[live(1,1),live(2,1),live(3,2)];claims=[];challenges=[];missions=[];soopLives=[];twitchLives=[{node:{id:'stream',viewersCount:10,broadcaster:{login:'streamer'}}}];twitchClaimed=false;error=false;video='playing';beforeFetch=null;
 globalThis.fetch=async (url,options)=>{
   if(beforeFetch)await beforeFetch();if(error)throw Error('offline');
   let body;
   if(url.includes('/info'))body={code:200,content:{dropsCampaignList:details.map(d=>({campaignNo:d.campaignNo,title:d.title}))}};
   else if(url.includes('/drops/campaigns/'))body={code:200,content:details.find(d=>String(d.campaignNo)===url.split('/').at(-1))};
   else if(url.includes('/lives?'))body={code:200,content:{data:lives,page:{next:null}}};
   else if(url.endsWith('/claims'))body={code:200,content:{claimList:claims}};
   else if(url.endsWith('/challenges'))body={code:200,content:{challengeList:challenges}};
   else if(url.includes('get_drops_mission_list'))body={result:1,data:missions};
   else if(url.includes('sch.sooplive'))body={result:1,data:{list:soopLives,is_more:false}};
   else if(url.includes('gql.twitch.tv')){
     const {operationName}=JSON.parse(options?.body||'{}');
     body=operationName==='HubDropsViewer'?{data:{currentUser:{login:'viewer'}}}:
       operationName==='HubDropsCampaigns'?{data:{currentUser:{dropCampaigns:[{id:'er',name:'이터널리턴 트위치',status:'ACTIVE',startAt:'2020-01-01T00:00:00Z',endAt:'2099-01-01T00:00:00Z',game:{id:'game',slug:'eternal-return',displayName:'Eternal Return'}}]}}}:
       operationName==='HubDropsInventory'?{data:{currentUser:{inventory:{gameEventDrops:[],dropCampaignsInProgress:twitchClaimed?[]:[{id:'er',timeBasedDrops:[{id:'reward',self:{isClaimed:false,currentMinutesWatched:12}}]}]}}}}:
       operationName==='HubDropsDetails'?{data:{user:{dropCampaign:{id:'er',name:'이터널리턴 트위치',status:'ACTIVE',startAt:'2020-01-01T00:00:00Z',endAt:'2099-01-01T00:00:00Z',game:{id:'game',slug:'eternal-return',displayName:'Eternal Return'},allow:{channels:[]},timeBasedDrops:[{id:'reward',requiredMinutesWatched:60,self:{isClaimed:twitchClaimed,currentMinutesWatched:12}}]}}}}:
       operationName==='HubDropsGameLives'?{data:{game:{id:'game',streams:{edges:twitchLives}}}}:null;
     if(!body)throw Error(operationName);
     return new Response(JSON.stringify(body));
   }
   else throw Error(url);
   return new Response(JSON.stringify(body));
 };
});
test('campaign-specific selection never opens another campaign',async()=>{data.settings.chzzkCollectCampaign='2';await checkCollector();assert.equal(data.collectorState.chzzk.campaignId,'2');assert.equal(tabs[0].url,'https://chzzk.naver.com/live/'+channel(3));});
test('offline broadcast switches within same campaign using one owned tab',async()=>{await checkCollector();const id=tabs[0].id;lives=[live(2,1),live(3,2,999)];await checkCollector();assert.equal(tabs.length,1);assert.equal(tabs[0].id,id);assert.equal(data.collectorState.chzzk.campaignId,'1');assert.equal(data.collectorState.chzzk.liveKey,'chzzk:2:1');});
test('completed campaign moves to next and closes own tab after all complete',async()=>{await checkCollector();claims=[{rewardNo:10}];await checkCollector();assert.equal(data.collectorState.chzzk.campaignId,'2');claims.push({rewardNo:20});await checkCollector();assert.equal(tabs.length,0);assert.match(data.collectorState.chzzk.status,/완료/);});
test('completion is not inferred from missing progress or watch timer',()=>{const c=campaignProgress(detail(1),[],[{rewardNo:10,accumWatchMinutes:60}]);assert.equal(c.completed,false);assert.equal(c.minutes,60);assert.equal(campaignProgress(detail(1),[],[]).completed,false);});
test('string zero stock is exhausted, but an unknown stock count remains watchable',()=>{
 const campaign=detail(1);
 campaign.rewardList[0].codeRemainingCount='0';
 assert.equal(campaignProgress(campaign,[],[]).watchable,false);
 campaign.rewardList[0].codeRemainingCount='';
 assert.equal(campaignProgress(campaign,[],[]).watchable,true);
 delete campaign.rewardList[0].codeRemainingCount;
 assert.equal(campaignProgress(campaign,[],[]).watchable,true);
});
test('another active campaign can play while every live in the current campaign cools down',()=>{
 const current={id:'1',lives:[{key:'chzzk:1:1',viewers:20}]};
 const next={id:'2',lives:[{key:'chzzk:2:2',viewers:10}]};
 const now=Date.now();
 const session={campaignId:'1',cooldowns:{'chzzk:1:1':now+60000}};
 assert.equal(chooseTarget({candidates:[current,next]},session,'auto',now)?.campaign.id,'2');
 assert.equal(chooseTarget({candidates:[current,next]},{campaignId:'1'},'auto',now)?.campaign.id,'1');
 assert.equal(chooseTarget({candidates:[current]},session,'1',now),null);
});
test('API failure preserves current tab and never declares complete',async()=>{await checkCollector();error=true;await checkCollector();assert.equal(tabs.length,1);assert.match(data.collectorState.chzzk.status,/실패/);});
test('turning off removes only owned tab',async()=>{await checkCollector();tabs.push({id:9,url:'https://example.com'});data.settings.autoCollectChzzk=false;await checkCollector();assert.deepEqual(tabs.map(t=>t.id),[9]);});
test('user closed or navigated tab pauses without reopening',async()=>{await checkCollector();tabs[0].url='https://example.com';await checkCollector();assert.equal(tabs.length,1);assert.equal(data.collectorState.chzzk.userStopped,true);data.settings.autoCollectChzzk=false;await checkCollector();assert.equal(tabs.length,1);});
test('paused CHZZK collection refreshes claims received on another computer without restarting playback',async()=>{
 await checkCollector();
 tabs[0].url='https://example.com';
 await checkCollector();
 claims=[{rewardNo:10},{rewardNo:20}];
 actions=[];await checkCollector();
 assert.equal(data.collectorState.chzzk.userStopped,true);
 assert.equal(data.collectorState.chzzk.campaigns.every(c=>c.completed),true);
 assert.match(data.collectorState.chzzk.status,/수령 완료/);
 assert.equal(data.collectorState.chzzk.error,null);
 assert.equal(actions.some(a=>['create','update','remove','play'].includes(a[0])),false);
});
test('paused CHZZK collection does not show old progress as current after a failed inventory read',async()=>{
 await checkCollector();tabs[0].url='https://example.com';await checkCollector();
 error=true;await checkCollector();
 assert.equal(data.collectorState.chzzk.userStopped,true);
 assert.match(data.collectorState.chzzk.status,/조회\/처리 실패/);
 assert.ok(data.collectorState.chzzk.error);
});
test('other platform live tabs block concurrent viewing',async()=>{tabs=[{id:9,url:'https://chzzk.naver.com/live/'+channel(8)}];await checkCollector();assert.equal(actions.length,0);assert.match(data.collectorState.chzzk.status,/다른 방송 탭/);});
test('disable during fetch prevents opening',async()=>{beforeFetch=async()=>{data.settings.autoCollectChzzk=false;};await checkCollector();assert.equal(tabs.length,0);});
test('server progress is displayed separately from successful playback',async()=>{await checkCollector();challenges=[{rewardNo:10,accumWatchMinutes:12}];await checkCollector();assert.match(data.collectorState.chzzk.status,/서버 시청 12분/);assert.match(data.collectorState.chzzk.status,/재생 중/);});
test('autoplay denial remains retryable without tab thrashing',async()=>{await checkCollector();video='blocked';await checkCollector();await checkCollector();assert.equal(actions.filter(a=>a[0]==='create').length,1);assert.match(data.collectorState.chzzk.status,/재시도/);});
test('three playback failures cool down failed broadcast and switch',async()=>{await checkCollector();video='stalled';await checkCollector();await checkCollector();await checkCollector();await checkCollector();assert.equal(data.collectorState.chzzk.liveKey,'chzzk:2:1');assert.equal(tabs.length,1);});
test('SOOP opens actual drops live then switches after ending',async()=>{data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];await checkCollector();assert.equal(tabs[0].url,'https://play.sooplive.com/first/1');soopLives=[{broad_no:2,broad_cate_no:'40120',is_drops:1,user_id:'second'}];await checkCollector();assert.equal(tabs.length,1);assert.equal(tabs[0].url,'https://play.sooplive.com/second/2');});
test('Twitch automatically opens and mutes an eligible live, then closes only its owned tab when disabled',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 await checkCollector();
 const owned=tabs.find(t=>t.id!==99);
 assert.equal(owned.url,'https://www.twitch.tv/streamer');
 assert.equal(owned.muted,true);
 assert.equal(tabs.find(t=>t.id===99).active,true);
 assert.match(data.collectorState.twitch.status,/서버 시청 12분/);
 data.settings.autoCollectTwitch=false;
 await checkCollector();
 assert.deepEqual(tabs.map(t=>t.id),[99]);
});
test('Twitch pauses after user navigation and does not replace a manually opened stream',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 tabs.push({id:99,windowId:1,url:'https://www.twitch.tv/another',active:true});
 await checkCollector();
 assert.equal(tabs.length,1);
 assert.match(data.collectorState.twitch.status,/다른 방송 탭/);
 tabs=[];
 await checkCollector();
 tabs[0].url='https://example.com';
 await checkCollector();
 assert.equal(data.collectorState.twitch.userStopped,true);
 assert.equal(tabs[0].url,'https://example.com');
});
test('paused Twitch collection refreshes rewards claimed on another computer',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 await checkCollector();tabs[0].url='https://example.com';await checkCollector();
 twitchClaimed=true;
 actions=[];await checkCollector();
 assert.equal(data.collectorState.twitch.userStopped,true);
 assert.equal(data.collectorState.twitch.campaigns[0].earned,1);
 assert.equal(data.collectorState.twitch.campaigns[0].completed,true);
 assert.match(data.collectorState.twitch.status,/수령 완료/);
 assert.equal(actions.some(a=>['create','update','remove','play'].includes(a[0])),false);
});
test('Twitch switches to another real live when server watch minutes remain unchanged',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 twitchLives.push({node:{id:'stream-2',viewersCount:5,broadcaster:{login:'backup'}}});
 await checkCollector();
 assert.equal(data.collectorState.twitch.liveKey,'twitch:streamer');
 data.collectorState.twitch.progressAt=Date.now()-11*60000;
 await checkCollector();
 assert.match(data.collectorState.twitch.status,/다른 방송으로 전환/);
 await checkCollector();
 assert.equal(data.collectorState.twitch.liveKey,'twitch:backup');
 assert.equal(tabs.length,1);
 assert.equal(tabs[0].url,'https://www.twitch.tv/backup');
});
test('Twitch player stays unmuted while its owned tab plays silently',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://www.twitch.tv/streamer';
 let started=0,clicks=0;
 const media={paused:true,ended:false,muted:false,defaultMuted:false,readyState:3,networkState:1,
  get currentTime(){return started ? (Date.now()-started)/1000 : 0;},
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  closest:()=>({}),matches:()=>false,async play(){throw Error('play should be handled by site control');}};
 const button={disabled:false,click(){clicks++;assert.equal(media.muted,false);media.paused=false;started=Date.now();}};
 globalThis.location={href:url+'?referrer=raid'};
 globalThis.document={querySelectorAll:()=>[media],querySelector:selector=>selector==='[data-a-target="player-play-pause-button"]'?button:null};
 try {
  const result=await (await import('../src/services/auto-collector.js')).controlVideo(url,true,'twitch');
  assert.equal(result.state,'playing');assert.equal(result.muted,false);assert.equal(clicks,1);assert.ok(result.deltaSeconds>2);
 } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
test('a manually unmuted owned Twitch tab is silenced before playback inspection',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 await checkCollector();
 tabs[0].muted=false;tabs[0].mutedInfo.muted=false;
 const original=chrome.scripting.executeScript;
 chrome.scripting.executeScript=async()=>{assert.equal(tabs[0].muted,true);return [{result:{state:'playing',muted:false,deltaSeconds:1}}];};
 try {await checkCollector();assert.equal(tabs[0].muted,true);}
 finally {chrome.scripting.executeScript=original;}
});
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
test('CHZZK verifies playback after hiding its tab and recovers without taking focus again',async()=>{
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 const original=chrome.scripting.executeScript;
 const calls=[];
 chrome.scripting.executeScript=async ({args})=>{
   const owned=tabs.find(t=>t.id!==99);
   calls.push({start:args[1],active:owned.active});
   return [{result:{state:owned.active || args[1] ? 'playing' : 'paused',muted:true,deltaSeconds:1}}];
 };
 try {
   await checkCollector();
   assert.deepEqual(calls.map(c=>[c.start,c.active]),[[true,true],[false,false],[true,false]]);
   assert.equal(data.collectorState.chzzk.diagnostic.recovery,'background');
   assert.equal(tabs.find(t=>t.id===99).active,true);
   assert.match(data.collectorState.chzzk.status,/재생 중/);
 } finally {chrome.scripting.executeScript=original;}
});
test('CHZZK recovers a stream that pauses later without switching tabs',async()=>{
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 await checkCollector();
 data.collectorState.chzzk.lastStartAt=Date.now()-60001;
 actions=[];
 const original=chrome.scripting.executeScript;
 const starts=[];
 chrome.scripting.executeScript=async ({args})=>{
   starts.push(args[1]);
   return [{result:{state:args[1]?'playing':'paused',muted:true,deltaSeconds:args[1]?1:0}}];
 };
 try {
   await checkCollector();
   assert.deepEqual(starts,[false,true]);
   assert.equal(actions.some(a=>a[0]==='update'&&a[1].active===true),false);
   assert.equal(tabs.find(t=>t.id===99).active,true);
   assert.equal(data.collectorState.chzzk.diagnostic.recovery,'background');
 } finally {chrome.scripting.executeScript=original;}
});
test('SOOP missions must match category, dates, and registered broadcaster',()=>{const rows=[{cateName:'이터널 리턴',title:'미션',dropsType:'B',startDate:'2020-01-01',endDate:'2099-01-01',itemList:[{percent:50,viewTime:30}],broadIdList:[{userId:'a',broadNo:1}]}];const r=soopMissions(rows,[{channelId:'a',liveId:'1'},{channelId:'b',liveId:'2'}]);assert.equal(r[0].lives.length,1);assert.equal(r[0].completed,false);rows[0].itemList[0].percent=100;assert.equal(soopMissions(rows,[])[0].completed,true);});
test('SOOP percent strings mark only fully watched missions complete',()=>{
 const row={cateName:'이터널 리턴',title:'미션',dropsType:'C',startDate:'2020-01-01',endDate:'2099-01-01',itemList:[{percent:'100%'},{percent:'99,5%'}]};
 assert.deepEqual(soopMissions([row],[]).map(({completed,earned})=>({completed,earned})),[{completed:false,earned:1}]);
 row.itemList[1].percent='100 %';
 assert.equal(soopMissions([row],[])[0].completed,true);
});
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


test('CHZZK starts with player audio enabled and relies on tab mute',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://chzzk.naver.com/live/'+channel(1);
 const media={paused:true,ended:false,muted:false,defaultMuted:false,currentTime:0,readyState:4,networkState:1,
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  async play(){assert.equal(this.muted,false);assert.equal(this.defaultMuted,false);this.paused=false;setTimeout(()=>{this.currentTime=1;},50);}};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media]};
 try {const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);assert.equal(r.state,'playing');assert.equal(r.muted,false);assert.ok(r.deltaSeconds>0);}
 finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
test('CHZZK uses muted autoplay only as a brief fallback, then restores player audio',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://chzzk.naver.com/live/'+channel(1);
 let attempts=0;
 const media={paused:true,ended:false,muted:false,defaultMuted:false,currentTime:0,readyState:4,networkState:1,
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  async play(){attempts++;if(!this.muted)throw Object.assign(Error('autoplay denied'),{name:'NotAllowedError'});
   this.paused=false;setTimeout(()=>{this.currentTime=1;},50);}};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media]};
 try {
  const result=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);
  assert.equal(result.state,'playing');assert.equal(attempts,2);
  assert.equal(media.muted,false);assert.equal(media.defaultMuted,false);
 } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
test('autoplay that stops on player unmute is reported as blocked, not playing',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://chzzk.naver.com/live/'+channel(1);
 let mediaMuted=false,started=false;
 const media={paused:true,ended:false,defaultMuted:false,currentTime:0,readyState:4,networkState:1,
  get muted(){return mediaMuted;},set muted(value){mediaMuted=value;if(started&&!value)this.paused=true;},
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  async play(){if(!this.muted)throw Object.assign(Error('autoplay denied'),{name:'NotAllowedError'});
   started=true;this.paused=false;}};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media]};
 try {
  const result=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);
  assert.equal(result.state,'blocked');assert.equal(result.reason,'AutoplayUnmutePaused');
  assert.equal(media.muted,false);
 } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
test('periodic Twitch check restores a site-muted player and zero volume',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://www.twitch.tv/streamer';
 const started=Date.now();
 const media={paused:false,ended:false,muted:true,defaultMuted:true,volume:0,readyState:4,networkState:1,
  get currentTime(){return (Date.now()-started)/1000;},
  getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
  closest:()=>({})};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media]};
 try {
  const result=await (await import('../src/services/auto-collector.js')).controlVideo(url,false,'twitch');
  assert.equal(result.state,'playing');assert.equal(result.muted,false);
  assert.equal(media.defaultMuted,false);assert.equal(media.volume,1);
 } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
test('follow-up setting change still runs after an uncaught cycle failure',async()=>{
 const original=chrome.storage.local.get;
 let entered,unblock;
 const began=new Promise(resolve=>{entered=resolve;});
 const gate=new Promise(resolve=>{unblock=resolve;});
 let failed=false;
 chrome.storage.local.get=async function(key){
  if(key==='collectorState'&&!failed){failed=true;entered();await gate;throw Error('storage temporarily unavailable');}
  return original.call(this,key);
 };
 try {
  const first=checkCollector();
  const rejection=assert.rejects(first,/storage temporarily unavailable/);
  await began;
  const followUp=checkCollector(true);
  unblock();
  await rejection;
  await followUp;
  assert.equal(tabs.length,1);
 } finally {chrome.storage.local.get=original;}
});
test('CHZZK starts its own player when the video has not been created yet',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://chzzk.naver.com/live/'+channel(1);
 let media=null,clicks=0,startedAt=0;
 const button={disabled:false,click(){clicks++;startedAt=Date.now();media={paused:false,ended:false,muted:false,defaultMuted:false,readyState:4,networkState:1,
   get currentTime(){return (Date.now()-startedAt)/1000;},
   getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
   matches:selector=>selector==="video[data-role='videoEl']",closest:()=>null};}};
 globalThis.location={href:url};
 globalThis.document={querySelectorAll:()=>media?[media]:[],querySelector:()=>button};
 try {
   const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);
   assert.equal(clicks,1);assert.equal(r.state,'playing');assert.equal(r.muted,false);
 } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
test('CHZZK ignores an advertising video and plays the designated live player',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://chzzk.naver.com/live/'+channel(1);
 let startedAt=0,clicks=0;
 const ad={paused:false,ended:false,currentTime:5,readyState:4,networkState:1,
   getBoundingClientRect(){return {width:1920,height:1080};},clientWidth:1920,clientHeight:1080,
   closest:()=>({}),matches:()=>false};
 const liveVideo={paused:true,ended:false,muted:false,defaultMuted:false,readyState:4,networkState:1,
   get currentTime(){return startedAt?(Date.now()-startedAt)/1000:0;},
   getBoundingClientRect(){return {width:640,height:360};},clientWidth:640,clientHeight:360,
   closest:()=>null,matches:selector=>selector==="video[data-role='videoEl']"};
 const button={disabled:false,click(){clicks++;liveVideo.paused=false;startedAt=Date.now();}};
 globalThis.location={href:url};
 globalThis.document={querySelectorAll:()=>[ad,liveVideo],querySelector:()=>button};
 try {
   const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);
   assert.equal(clicks,1);assert.equal(r.state,'playing');assert.equal(r.muted,false);
 } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
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
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media],querySelector:()=>null};
 try {const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true,'soop');assert.equal(r.state,'blocked');assert.equal(r.reason,'NotAllowedError');assert.equal(JSON.stringify(r).includes('private URL'),false);}
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

test('SOOP official host redirects keep the owned broadcast in both directions',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;
 soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];
 await checkCollector();
 tabs[0].url='https://play.sooplive.co.kr/first/1';
 actions=[];await checkCollector();
 assert.equal(data.collectorState.soop.userStopped,undefined);
 assert.equal(data.collectorState.soop.diagnostic.state,'playing');
 assert.equal(actions.some(a=>a[0]==='create'||a[0]==='update'&&a[1].url),false);
 data.collectorState.soop.url='https://play.sooplive.co.kr/first/1';
 tabs[0].url='https://play.sooplive.com/first/1';
 await checkCollector();
 assert.equal(data.collectorState.soop.userStopped,undefined);
 assert.equal(data.collectorState.soop.diagnostic.state,'playing');
});
test('SOOP matching pending host redirect is owned; another broadcast pauses without overwrite',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectSoop=true;
 soopLives=[{broad_no:1,broad_cate_no:'40120',is_drops:1,user_id:'first'}];
 await checkCollector();
 Object.assign(tabs[0],{pendingUrl:'https://play.sooplive.co.kr/first/1',status:'loading'});
 await checkCollector();
 assert.equal(data.collectorState.soop.userStopped,undefined);
 Object.assign(tabs[0],{url:'https://play.sooplive.co.kr/other/999',pendingUrl:undefined,status:'complete'});
 actions=[];await checkCollector();
 assert.equal(data.collectorState.soop.userStopped,true);
 assert.equal(tabs[0].url,'https://play.sooplive.co.kr/other/999');
 assert.equal(actions.some(a=>a[0]==='update'&&a[1].url),false);
});
test('injected SOOP playback accepts only matching official host redirects',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const expected='https://play.sooplive.com/first/1';
 globalThis.document={querySelectorAll:()=>[],querySelector:()=>null};
 try {
   globalThis.location={href:'https://play.sooplive.co.kr/first/1'};
   assert.equal((await (await import('../src/services/auto-collector.js')).controlVideo(expected,false,'soop')).state,'missing');
   for (const href of ['https://play.sooplive.co.kr/other/999','https://play.sooplive.co.kr/first/1?next=x','https://example.com/']) {
     globalThis.location={href};
     assert.equal((await (await import('../src/services/auto-collector.js')).controlVideo(expected,false,'soop')).state,'navigation');
   }
 } finally {globalThis.location=originalLocation;globalThis.document=originalDocument;}
});
