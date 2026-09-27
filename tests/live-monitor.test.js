import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
let data, notifications, tabs, calls, fail, pause;
globalThis.chrome = {
 storage: {local: {async get(k) {return structuredClone({[k]:data[k]});}, async set(v){Object.assign(data,structuredClone(v));}}},
 runtime:{getURL:p=>'chrome-extension://test/'+p},
 alarms:{async get(){return null;},async create(n,v){data.alarm=v;},async clear(){delete data.alarm;}},
 notifications:{async create(id,v){notifications.push({id,...v});}},
 tabs:{async query(){return tabs;},async create(v){const t={id:tabs.length+1,...v};tabs.push(t);return t;},async update(id,v){Object.assign(tabs.find(t=>t.id===id),v);return tabs.find(t=>t.id===id);}}
};
const live = (id=1)=>({liveId:id,liveCategory:'Black_Survival_Eternal_Return',dropsCampaignNo:123,channel:{channelId:'a'.repeat(32),channelName:'테스트'},concurrentUserCount:10});
const soop = {broad_no:2,broad_cate_no:'00040120',is_drops:1,user_id:'tester',user_nick:'테스트'};
let chzzk, soops;
beforeEach(()=>{data={settings:{liveMonitorEnabled:true,liveAutoOpen:false}};notifications=[];tabs=[];calls=0;fail=false;pause=null;chzzk=[live()];soops=[soop];globalThis.fetch=async url=>{calls++;if(pause)await pause();if(fail)throw Error('offline');return new Response(JSON.stringify(url.includes('chzzk')?{code:200,content:{data:chzzk,page:{next:null}}}:{result:1,data:{list:soops,is_more:false}}));};});
const m=await import('../src/services/live-monitor.js');
test('only exact category and actual drops flags qualify',()=>{assert.ok(m.normalizeChzzkLive(live()));assert.equal(m.normalizeChzzkLive({...live(),dropsCampaignNo:null}),null);assert.equal(m.normalizeChzzkLive({...live(),liveCategory:'other'}),null);assert.equal(m.normalizeSoopLive({...soop,is_drops:'0',broad_title:'드롭스'}),null);assert.equal(m.normalizeSoopLive({...soop,is_password:1}),null);assert.ok(m.normalizeSoopLive(soop));assert.equal(m.normalizeChzzkLive(null),null);});
test('disabled does not fetch and clears alarm',async()=>{data.settings.liveMonitorEnabled=false;await m.checkLiveMonitor();await m.ensureLiveAlarm();assert.equal(calls,0);assert.equal(data.alarm,undefined);});
test('one minute alarm',async()=>{await m.ensureLiveAlarm();assert.equal(data.alarm.periodInMinutes,1);});
test('notifications deduplicate by campaign, not broadcast',async()=>{await m.checkLiveMonitor();assert.equal(notifications.length,2);await m.checkLiveMonitor();assert.equal(notifications.length,2);chzzk=[live(3)];await m.checkLiveMonitor();assert.equal(notifications.length,2);chzzk=[{...live(4),dropsCampaignNo:456}];await m.checkLiveMonitor();assert.equal(notifications.length,3);});
test('auto opening one tab per platform with no focus stealing',async()=>{data.settings.liveAutoOpen=true;chzzk=[live(),live(3)];await m.checkLiveMonitor();assert.equal(tabs.length,2);assert.ok(tabs.every(t=>t.active===false));await m.checkLiveMonitor();assert.equal(tabs.length,2);});
test('enabling auto open later opens known broadcasts',async()=>{await m.checkLiveMonitor();assert.equal(tabs.length,0);data.settings.liveAutoOpen=true;await m.checkLiveMonitor();assert.equal(tabs.length,2);assert.equal(notifications.length,2);});
test('existing eligible tab is reused',async()=>{tabs=[{id:1,url:'https://chzzk.naver.com/live/'+'a'.repeat(32)}];data.settings.liveAutoOpen=true;await m.checkLiveMonitor();assert.equal(tabs.length,2);});
test('disable during fetch prevents actions',async()=>{pause=async()=>{data.settings.liveMonitorEnabled=false;};await m.checkLiveMonitor();assert.equal(notifications.length,0);assert.equal(tabs.length,0);});
test('failed fetch preserves dedupe and reports error',async()=>{await m.checkLiveMonitor();fail=true;await m.checkLiveMonitor();assert.match(data.liveMonitorState.platforms.chzzk.error,/연결 실패/);fail=false;await m.checkLiveMonitor();assert.equal(notifications.length,2);});
test('notification click validates destinations',async()=>{await m.checkLiveMonitor();await m.openLiveNotification(notifications.find(n=>n.id.startsWith('er-live:chzzk')).id);assert.equal(tabs.length,1);assert.equal(tabs[0].active,true);data.liveMonitorState.notices[notifications.find(n=>n.id.startsWith('er-live:soop')).id].url='https://evil.example';await m.openLiveNotification(notifications.find(n=>n.id.startsWith('er-live:soop')).id);assert.equal(tabs.length,1);});
test('concurrent checks share one fetch cycle',async()=>{await Promise.all([m.checkLiveMonitor(),m.checkLiveMonitor()]);assert.equal(calls,2);assert.equal(notifications.length,2);});
test('pagination fetches next pages',async()=>{globalThis.fetch=async url=>{const u=new URL(url);const next=u.searchParams.has('liveId');return new Response(JSON.stringify({code:200,content:{data:[live(next?2:1)],page:{next:next?null:{liveId:1,concurrentUserCount:10}}}}));};assert.equal((await m.fetchChzzkEternalLives()).length,2);});


test('a SOOP tab at an older broadcast is not mistaken for the current stream', async()=>{
 data.settings.liveAutoOpen=true; chzzk=[];
 tabs=[{id:1,url:'https://play.sooplive.com/tester/1'}];
 await m.checkLiveMonitor();
 assert.equal(tabs.length,2); assert.equal(tabs[1].url,'https://play.sooplive.com/tester/2');
});
test('user navigation in progress prevents owned tab replacement',async()=>{
 data.settings.liveAutoOpen=true;soops=[];
 const old='https://chzzk.naver.com/live/'+'b'.repeat(32);
 tabs=[{id:1,url:old,pendingUrl:'https://chzzk.naver.com/live/'+'c'.repeat(32)}];
 data.liveMonitorState={openedTabs:{chzzk:{id:1,url:old}}};
 await m.checkLiveMonitor();assert.equal(tabs[0].url,old);assert.equal(tabs.length,2);
});
test('notification click target stays paired with its original message',async()=>{
 await m.checkLiveMonitor();const first=notifications[0].id;
 chzzk=[{...live(3),dropsCampaignNo:456,channel:{channelId:'b'.repeat(32)}}];await m.checkLiveMonitor();
 assert.notEqual(notifications.at(-1).id,first);
 assert.equal(data.liveMonitorState.notices[first].url,'https://chzzk.naver.com/live/'+'a'.repeat(32));
});
test('successful notification is saved before starting tab work',async()=>{
 const original=chrome.tabs.query;data.settings.liveAutoOpen=true;let savedBeforeTabs=false;
 try {chrome.tabs.query=async()=>{savedBeforeTabs=data.liveMonitorState.seen['chzzk:1:123'].notified===true;return [];};await m.checkLiveMonitor();assert.equal(savedBeforeTabs,true);}
 finally {chrome.tabs.query=original;}
});
test('notification URLs reject extra ports and query redirects',()=>{
 assert.equal(m.validLiveUrl('https://chzzk.naver.com:444/live/'+'a'.repeat(32)),false);
 assert.equal(m.validLiveUrl('https://play.sooplive.com/tester/2?next=other'),false);
});


test('same campaign stays silent after empty polls and worker module reload',async()=>{
 await m.checkLiveMonitor();chzzk=[];soops=[];await m.checkLiveMonitor();
 chzzk=[live(99)];soops=[{...soop,broad_no:999}];
 const reloaded=await import('../src/services/live-monitor.js?restart');
 await reloaded.checkLiveMonitor();assert.equal(notifications.length,2);
});
test('upgrade migrates already notified broadcasts into campaign history',async()=>{
 data.liveMonitorState={seen:{'chzzk:7:123':{lastSeen:Date.now(),notified:true},'soop:7':{lastSeen:Date.now(),notified:true}}};
 await m.checkLiveMonitor();assert.equal(notifications.length,0);
});
test('failed notifications remain retryable',async()=>{
 const original=chrome.notifications.create;
 try {chrome.notifications.create=async()=>{throw Error('failed');};await m.checkLiveMonitor();assert.ok(!data.liveMonitorState.notificationGroups['chzzk:campaign:123'].notified);}
 finally {chrome.notifications.create=original;}
 await m.checkLiveMonitor();assert.equal(notifications.length,2);
});


test('Korean reset boundary is 05:00, not midnight',async()=>{
 const {dropsDay}=await import('../src/services/drops-day.js');
 assert.equal(dropsDay(Date.parse('2026-09-22T04:59:59+09:00')),'2026-09-21');
 assert.equal(dropsDay(Date.parse('2026-09-22T05:00:00+09:00')),'2026-09-22');
 assert.equal(dropsDay(Date.parse('2027-01-01T00:00:00+09:00')),'2026-12-31');
});
test('same campaigns notify again at 05:00 only once, including after restart',async()=>{
 const original=Date.now;let now=Date.parse('2026-09-21T23:59:00+09:00');Date.now=()=>now;
 try {
  await m.checkLiveMonitor();assert.equal(notifications.length,2);
  now=Date.parse('2026-09-22T04:59:59+09:00');await m.checkLiveMonitor();assert.equal(notifications.length,2);
  now=Date.parse('2026-09-22T05:00:00+09:00');await m.checkLiveMonitor();assert.equal(notifications.length,4);
  const restarted=await import('../src/services/live-monitor.js?daily-reset-test');
  await restarted.checkLiveMonitor();assert.equal(notifications.length,4);
  now+=3*86400000;await restarted.checkLiveMonitor();assert.equal(notifications.length,6);
 } finally {Date.now=original;}
});

test('SOOP live URLs accept only strict official broadcast addresses',()=>{
 const valid=['https://play.sooplive.com/tester/123','https://play.sooplive.co.kr/tester/123'];
 for (const url of valid) assert.equal(m.validLiveUrl(url),true,url);
 for (const url of ['http://play.sooplive.co.kr/tester/123','https://play.sooplive.co.kr:443/tester/123',
   'https://user@play.sooplive.co.kr/tester/123','https://play.sooplive.co.kr/tester/123?q=1',
   'https://play.sooplive.co.kr/tester/123#x','https://evil.example/tester/123',
   'https://play.sooplive.co.kr/tester','https://play.sooplive.co.kr/tester/123/extra'])
   assert.equal(m.validLiveUrl(url),false,url);
 assert.equal(m.sameLiveUrl(valid[0],valid[1]),true);
 assert.equal(m.sameLiveUrl(valid[1],valid[0]),true);
 assert.equal(m.sameLiveUrl(valid[0],'https://play.sooplive.co.kr/other/999'),false);
});
test('SOOP monitor reuses its owned tab after official host redirect',async()=>{
 data.settings.liveAutoOpen=true;chzzk=[];
 await m.checkLiveMonitor();
 assert.equal(tabs.length,1);
 tabs[0].url='https://play.sooplive.co.kr/tester/2';
 soops=[{...soop,broad_no:3}];
 await m.checkLiveMonitor();
 assert.equal(tabs.length,1);
 assert.equal(tabs[0].url,'https://play.sooplive.com/tester/3');
});
