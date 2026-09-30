import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let data, tabs, actions, details, lives, claims, challenges, missions, soopLives, twitchLives, twitchClaimed, twitchAwards, twitchMinutes, error, video, beforeFetch;
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
const {campaignProgress}=await import('../src/services/collector-plans.js');
beforeEach(()=>{
 data={settings:{autoCollectChzzk:true,autoCollectSoop:false,chzzkCollectCampaign:'auto'}};tabs=[];actions=[];details=[detail(1),detail(2)];lives=[live(1,1),live(2,1),live(3,2)];claims=[];challenges=[];missions=[];soopLives=[];twitchLives=[{node:{id:'stream',viewersCount:10,broadcaster:{login:'streamer'}}}];twitchClaimed=false;twitchAwards=[];twitchMinutes=12;error=false;video='playing';beforeFetch=null;
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
     body=operationName==='HubDropsViewer'?{data:{currentUser:{id:'user-1',login:'viewer'}}}:
       operationName==='HubDropsCampaigns'?{data:{currentUser:{dropCampaigns:[{id:'er',name:'이터널리턴 트위치',status:'ACTIVE',startAt:'2020-01-01T00:00:00Z',endAt:'2099-01-01T00:00:00Z',game:{id:'game',slug:'eternal-return',displayName:'Eternal Return'}}]}}}:
       operationName==='HubDropsInventory'?{data:{currentUser:{inventory:{dropCampaignsInProgress:twitchClaimed?[]:[{id:'er',timeBasedDrops:[{id:'reward',self:{isClaimed:false,currentMinutesWatched:twitchMinutes}}]}]}}}}:
       operationName==='Inventory'?{data:{currentUser:{inventory:{gameEventDrops:twitchAwards}}}}:
       operationName==='HubDropsDetails'?{data:{user:{dropCampaign:{id:'er',name:'이터널리턴 트위치',status:'ACTIVE',startAt:'2020-01-01T00:00:00Z',endAt:'2099-01-01T00:00:00Z',game:{id:'game',slug:'eternal-return',displayName:'Eternal Return'},allow:{channels:[]},timeBasedDrops:[{id:'reward',requiredMinutesWatched:60,benefitEdges:[{benefit:{id:'token'}}],self:{isClaimed:twitchClaimed,currentMinutesWatched:twitchMinutes}}]}}}}:
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
test('Twitch does not treat an aggregate award as proof of a claimed campaign',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 twitchMinutes=0;twitchAwards=[{id:'token',lastAwardedAt:new Date().toISOString()}];
 await checkCollector();
 assert.equal(tabs.length,1);
 assert.equal(data.collectorState.twitch.campaigns[0].completed,false);
 assert.equal(data.collectorState.twitch.campaigns[0].verificationPending,undefined);
 assert.match(data.collectorState.twitch.status,/재생 중/);
});

test('Twitch local receipt closes only its owned live even if the server returns zero progress', async () => {
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 tabs.push({id:99,windowId:1,url:'https://example.com',active:true});
 await checkCollector(); assert.equal(tabs.length,2);
 twitchMinutes=0;
 data['handled:twitch_instance-1']={platform:'twitch',actionType:'claimed',twitchUserId:'user-1',
   campaignId:'er',timeBasedDropId:'reward',dropInstanceId:'instance-1',claimedAt:Date.now()};
 await checkCollector();
 assert.deepEqual(tabs.map(t=>t.id),[99]);assert.equal(data.collectorState.twitch.campaigns[0].completed,true);
 assert.equal(data.collectorState.twitch.claimedToday,1);assert.match(data.collectorState.twitch.status,/완료/);
});
test('obsolete Twitch manual choices do not prevent automatic collection',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 twitchMinutes=0;
 data.twitchCampaignOverrides={'viewer:er':{mode:'completed',endAt:Date.parse('2099-01-01T00:00:00Z')}};
 await checkCollector();
 assert.equal(tabs.length,1);
 assert.equal(data.collectorState.twitch.campaigns[0].manualCompleted,undefined);
 assert.equal(data.collectorState.twitch.campaigns[0].completed,false);
});
test('Twitch starts a fresh campaign without requiring award-history confirmation',async()=>{
 data.settings.autoCollectChzzk=false;data.settings.autoCollectTwitch=true;
 twitchMinutes=0;twitchAwards=null;
 await checkCollector();
 assert.equal(tabs.length,1);
 assert.equal(data.collectorState.twitch.campaigns[0].verificationPending,undefined);
 assert.match(data.collectorState.twitch.status,/재생 중/);
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
test('catalog choice persists when selected campaign temporarily has no live',async()=>{data.settings.chzzkCollectCampaign='2';lives=[live(1,1)];await checkCollector();assert.equal(tabs.length,0);assert.match(data.collectorState.chzzk.status,/대기/);});
test('one minute collection alarm and disabled cleanup',async()=>{await ensureCollectorAlarm();assert.equal(data.alarm.periodInMinutes,1);data.settings.autoCollectChzzk=false;await ensureCollectorAlarm();assert.equal(data.alarm,undefined);});

test('OFF request during failed in-flight cycle still closes owned tab',async()=>{
 await checkCollector();let unblock,entered;const began=new Promise(r=>{entered=r;});const gate=new Promise(r=>{unblock=r;});
 beforeFetch=async()=>{entered();await gate;throw Error('network failure');};
 const active=checkCollector();await began;data.settings.autoCollectChzzk=false;
 const stopped=checkCollector(true);unblock();await active;await stopped;
 assert.equal(tabs.length,0);assert.equal(data.collectorState.chzzk.status,'꺼짐');
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

test('NotAllowedError is recorded without storing the exception message',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;
 const url='https://play.sooplive.com/tester/1';
 const media={paused:true,ended:false,muted:false,defaultMuted:false,currentTime:0,readyState:2,networkState:1,
  getBoundingClientRect(){return {width:0,height:0};},
  play(){return Promise.reject(Object.assign(Error('private URL or cookie must not be stored'),{name:'NotAllowedError'}));}};
 globalThis.location={href:url};globalThis.document={querySelectorAll:()=>[media],querySelector:()=>null};
 try {const r=await (await import('../src/services/auto-collector.js')).controlVideo(url,true,'chzzk');assert.equal(r.state,'blocked');assert.equal(r.reason,'NotAllowedError');assert.equal(JSON.stringify(r).includes('private URL'),false);}
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


test('retiring SOOP collection closes only the legacy owned broadcast even when all collectors are off',async()=>{
 data.settings={autoCollectChzzk:false,autoCollectSoop:true,autoCollectTwitch:false};
 const url='https://play.sooplive.com/first/1';
 tabs=[{id:1,url},{id:2,url:'https://play.sooplive.com/second/2'}];
 data.collectorState={soop:{tabId:1,url}};
 await ensureCollectorAlarm();
 assert.deepEqual(tabs.map(t=>t.id),[2]);
 assert.equal(data.collectorState.soop,undefined);
 assert.equal(data.alarm,undefined);
 assert.equal(actions.some(a=>a[0]==='play'||a[0]==='create'),false);
});
test('retiring SOOP collection leaves a user-navigated legacy tab alone',async()=>{
 data.settings={autoCollectChzzk:false,autoCollectSoop:true};
 data.collectorState={soop:{tabId:1,url:'https://play.sooplive.com/first/1'}};
 tabs=[{id:1,url:'https://example.com'}];
 await checkCollector();
 assert.equal(tabs.length,1);assert.equal(data.collectorState.soop,undefined);
});

test('CHZZK foreground recovery starts a player that refuses background play and restores the user tab',async()=>{
 tabs=[{id:99,windowId:1,url:'https://example.com',active:true}];await checkCollector();
 data.collectorState.chzzk.lastStartAt=Date.now()-60001;
 const original=chrome.scripting.executeScript;let repaired=false;
 chrome.scripting.executeScript=async ({args})=>{
  const tab=tabs.find(t=>t.id!==99);
  if(args[1]&&tab.active)repaired=true;
  return [{result:{state:repaired?'playing':args[1]?'blocked':'paused',hidden:!tab.active,deltaSeconds:repaired?1:0}}];
 };
 try {
  actions=[];await checkCollector();
  assert.match(data.collectorState.chzzk.status,/재생 중/);
  assert.equal(data.collectorState.chzzk.diagnostic.recovery,'foreground');
  assert.equal(tabs.find(t=>t.id===99).active,true);
  assert.equal(tabs.find(t=>t.id!==99).muted,true);
  assert.equal(actions.filter(a=>a[0]==='update'&&a[1].active===true).length,2);
 }finally{chrome.scripting.executeScript=original;}
});
test('CHZZK recovery restores a minimized window and verifies playback after it becomes hidden again',async()=>{
 tabs=[{id:99,windowId:1,url:'https://example.com',active:true}];await checkCollector();
 data.collectorState.chzzk.lastStartAt=Date.now()-60001;
 const original=chrome.scripting.executeScript;const originalWindows=chrome.windows;
 let win={id:1,state:'minimized',focused:false},repaired=false,hiddenRestored=false,updates=[];
 chrome.windows={async get(){return {...win};},async getLastFocused(){return {id:2,state:'normal',focused:true};},async update(id,values){updates.push([id,values]);if(id===1)Object.assign(win,values);return {...win};}};
 chrome.scripting.executeScript=async ({args})=>{
  const tab=tabs.find(t=>t.id!==99);
  if(tab.active&&args[1]&&win.state==='normal')repaired=true;
  if(repaired&&win.state==='minimized'){hiddenRestored=true;if(args[1])return [{result:{state:'playing',hidden:true,deltaSeconds:1}}];return [{result:{state:'paused',hidden:true}}];}
  return [{result:{state:repaired?'playing':args[1]?'blocked':'paused'}}];
 };
 try{
  await checkCollector();
  assert.deepEqual(updates,[[1,{focused:true,state:'normal'}],[1,{state:'minimized'}],[2,{focused:true}]]);
  assert.equal(hiddenRestored,true);assert.equal(win.state,'minimized');
  assert.equal(data.collectorState.chzzk.diagnostic.state,'playing');
  assert.equal(data.collectorState.chzzk.diagnostic.hidden,true);
 }finally{chrome.scripting.executeScript=original;chrome.windows=originalWindows;}
});
test('CHZZK media error reloads only its owned tab before recovery',async()=>{
 tabs=[{id:99,windowId:1,url:'https://example.com',active:true}];await checkCollector();
 data.collectorState.chzzk.lastStartAt=Date.now()-60001;
 const original=chrome.scripting.executeScript,originalReload=chrome.tabs.reload;let reloaded=false,ids=[];
 chrome.tabs.reload=async id=>{ids.push(id);reloaded=true;};
 chrome.scripting.executeScript=async()=>[{result:reloaded?{state:'playing',deltaSeconds:1}:{state:'error',reason:'MediaError2'}}];
 try{await checkCollector();assert.deepEqual(ids,[data.collectorState.chzzk.tabId]);assert.notEqual(ids[0],99);assert.match(data.collectorState.chzzk.status,/재생 중/);}
 finally{chrome.scripting.executeScript=original;chrome.tabs.reload=originalReload;}
});
test('CHZZK recovery is limited across broadcast changes and skips healthy streams',async()=>{
 tabs=[{id:99,windowId:1,url:'https://example.com',active:true}];await checkCollector();
 const stamp=Date.now();data.collectorState.chzzk.lastForegroundRecoveryAt=stamp;data.collectorState.chzzk.lastStartAt=Date.now()-60001;
 const original=chrome.scripting.executeScript;
 chrome.scripting.executeScript=async()=>[{result:{state:'blocked',reason:'NotAllowedError'}}];
 try{actions=[];await checkCollector();assert.equal(actions.some(a=>a[0]==='update'&&a[1].active===true),false);assert.equal(data.collectorState.chzzk.lastForegroundRecoveryAt,stamp);}
 finally{chrome.scripting.executeScript=original;}
 actions=[];await checkCollector();assert.equal(actions.some(a=>a[0]==='update'&&a[1].active===true),false);
});
test('CHZZK leaves a user tab switch made during foreground recovery in place',async()=>{
 tabs=[{id:99,windowId:1,url:'https://example.com',active:true}];await checkCollector();
 tabs.push({id:98,windowId:1,url:'https://example.org',active:false});
 data.collectorState.chzzk.lastStartAt=Date.now()-60001;
 const original=chrome.scripting.executeScript;let recovered=false;
 chrome.scripting.executeScript=async({args})=>{
  const tab=tabs.find(t=>t.id===data.collectorState.chzzk.tabId);
  if(args[1]&&tab.active){await chrome.tabs.update(98,{active:true});recovered=true;}
  return [{result:{state:recovered?'playing':args[1]?'blocked':'paused',deltaSeconds:recovered?1:0}}];
 };
 try{await checkCollector();assert.equal(tabs.find(t=>t.id===98).active,true);assert.equal(tabs.find(t=>t.id===99).active,false);}
 finally{chrome.scripting.executeScript=original;}
});
test('CHZZK finds its live video and play control inside an open shadow root',async()=>{
 const originalLocation=globalThis.location,originalDocument=globalThis.document;const url='https://chzzk.naver.com/live/'+channel(1);
 let started=0,clicks=0;
 const media={paused:true,ended:false,muted:true,defaultMuted:true,volume:0,readyState:4,networkState:1,
  matches:s=>s.includes('videoEl'),getBoundingClientRect:()=>({width:640,height:360}),clientWidth:640,clientHeight:360,
  get currentTime(){return started?(Date.now()-started)/1000:0;},async play(){this.paused=false;started=Date.now();}};
 const root={querySelectorAll:s=>s==='video'?[media]:[],querySelector:()=>({click(){clicks++;media.play();}})};
 globalThis.location={href:url};globalThis.document={visibilityState:'hidden',hasFocus:()=>false,querySelectorAll:s=>s==='*'?[{shadowRoot:root}]:[],querySelector:()=>null};
 try{const result=await (await import('../src/services/auto-collector.js')).controlVideo(url,true);assert.equal(result.state,'playing');assert.equal(clicks,1);assert.equal(result.muted,false);assert.equal(result.hidden,true);assert.equal(result.hasFocus,false);}
 finally{globalThis.location=originalLocation;globalThis.document=originalDocument;}
});

test('gesture playback targets only the owned CHZZK tab and detaches after success',async()=>{
 await checkCollector();const session=data.collectorState.chzzk;const original=chrome.debugger;const commands=[];
 chrome.debugger={async attach(target,version){commands.push(['attach',target,version]);},async sendCommand(target,method,params){commands.push(['command',target,method]);assert.equal(params.userGesture,true);assert.equal(params.awaitPromise,true);assert.equal(params.returnByValue,true);assert.ok(params.expression.includes(JSON.stringify(session.url)));return {result:{value:{state:'playing',muted:false,deltaSeconds:1}}};},async detach(target){commands.push(['detach',target]);}};
 try{const result=await (await import('../src/services/auto-collector.js')).startWithBrowserGesture(session);assert.equal(result.state,'playing');assert.deepEqual(commands,[['attach',{tabId:session.tabId},'1.3'],['command',{tabId:session.tabId},'Runtime.evaluate'],['detach',{tabId:session.tabId}]]);assert.equal(tabs[0].muted,true);}
 finally{chrome.debugger=original;}
});
test('gesture playback does not attach to a foreign platform even with matching tab ownership',async()=>{
 const original=chrome.debugger;let calls=0;chrome.debugger={async attach(){calls++;}};
 tabs=[{id:1,url:'https://www.twitch.tv/tester',active:true}];
 try{const result=await (await import('../src/services/auto-collector.js')).startWithBrowserGesture({tabId:1,url:tabs[0].url});assert.equal(result.state,'navigation');assert.equal(calls,0);}
 finally{chrome.debugger=original;}
});
test('gesture playback cancels and detaches if the user navigates during attach',async()=>{
 await checkCollector();const session=data.collectorState.chzzk,original=chrome.debugger;let commands=0,detached=0;
 chrome.debugger={async attach(){tabs[0].url='https://example.com';},async sendCommand(){commands++;},async detach(){detached++;}};
 try{const result=await (await import('../src/services/auto-collector.js')).startWithBrowserGesture(session);assert.equal(result.state,'navigation');assert.equal(commands,0);assert.equal(detached,1);}
 finally{chrome.debugger=original;}
});
test('gesture playback cancels and detaches when collection is disabled during attach',async()=>{
 await checkCollector();const session=data.collectorState.chzzk,original=chrome.debugger;let commands=0,detached=0;
 chrome.debugger={async attach(){data.settings.autoCollectChzzk=false;},async sendCommand(){commands++;},async detach(){detached++;}};
 try{const result=await (await import('../src/services/auto-collector.js')).startWithBrowserGesture(session);assert.equal(result.state,'cancelled');assert.equal(commands,0);assert.equal(detached,1);}
 finally{chrome.debugger=original;}
});
test('an unavailable gesture connection never detaches another debugger or exposes its error',async()=>{
 await checkCollector();const session=data.collectorState.chzzk,original=chrome.debugger;let detached=0;
 chrome.debugger={async attach(){throw Error('private details');},async detach(){detached++;}};
 try{const result=await (await import('../src/services/auto-collector.js')).startWithBrowserGesture(session);assert.equal(result.reason,'BrowserGestureUnavailable');assert.equal(detached,0);assert.equal(JSON.stringify(result).includes('private'),false);}
 finally{chrome.debugger=original;}
});
test('gesture evaluation failure remains blocked and always detaches its own connection',async()=>{
 await checkCollector();const session=data.collectorState.chzzk,original=chrome.debugger;let detached=0;
 chrome.debugger={async attach(){},async sendCommand(){return {exceptionDetails:{text:'private details'}};},async detach(){detached++;}};
 try{const result=await (await import('../src/services/auto-collector.js')).startWithBrowserGesture(session);assert.equal(result.state,'blocked');assert.equal(result.reason,'BrowserGestureFailed');assert.equal(detached,1);}
 finally{chrome.debugger=original;}
});

test('gesture playback refuses a CHZZK tab absent from persisted collector ownership',async()=>{
 const original=chrome.debugger;let calls=0;chrome.debugger={async attach(){calls++;}};
 const url='https://chzzk.naver.com/live/'+channel(1);tabs=[{id:1,url,active:true}];
 try{const result=await (await import('../src/services/auto-collector.js')).startWithBrowserGesture({tabId:1,url});assert.equal(result.state,'navigation');assert.equal(calls,0);}
 finally{chrome.debugger=original;}
});
