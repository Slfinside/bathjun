import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createApp} from '../src/app.js';
import {createHttpServer} from '../src/http.js';
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
const executablePath=process.env.BATHJUN_BROWSER_PATH||['/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
assert.ok(executablePath,'Install Chrome/Chromium or set BATHJUN_BROWSER_PATH');
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const output=process.env.BATHJUN_BROWSER_SCREENSHOTS;
if(output)mkdirSync(output,{recursive:true});
async function scenario(name,fn,{maxDuration=90}={}){
 const directory=mkdtempSync(join(tmpdir(),'bathjun-browser-'));
 let clock=new Date('2026-11-02T08:00:00+09:00');
 const app=createApp({database:join(directory,'test.sqlite'),requireFamily:false,now:()=>clock,deliverPush:async()=>{}});
 app.saveServerSettings({members:[{name:'利用者A',active:true},{name:'利用者B',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed',maxDuration}});
 clock=new Date('2026-11-04T08:00:00+09:00');
 const {server}=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'ja-JP'}),page=await context.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 const api=async(path,body)=>{const r=await context.request.post(url+'/api/'+path,{data:body});assert.equal(r.status(),200,await r.text());return r.json()};
 const state=async(day='2026-11-04')=>(await context.request.get(url+'/api/state?day='+day)).json();
 const navigate=async(label,selector)=>{await page.locator('.account-menu > summary').click();await page.getByRole('navigation',{name:'メニュー'}).getByRole('button',{name:label,exact:true}).click();await page.locator(selector).waitFor()};
 try{
  await api('register',{memberId:1,password:'test-only'});await state();
  await fn({app,page,context,url,api,state,navigate,time:value=>clock=new Date(value+'+09:00'),
    screenshot:async suffix=>{if(output)await page.screenshot({path:join(output,name+'-'+suffix+'.png')});}
  });
  assert.deepEqual(errors,[]);console.log('PASS',name);
 }finally{await context.close();await new Promise(r=>server.close(r));app.close();rmSync(directory,{recursive:true,force:true})}
}
try {
 await scenario('rebooking',async({app,page,context,url,api,state,time,screenshot})=>{
  assert.equal(app.getRewardsAdmin().settings.clientReportEnabled,false);
  await api('book',{day:'2026-11-04',start:1080,duration:30});const original=(await state()).bookings[0];
  time('2026-11-04T18:32:00');await page.goto(url);
  const modal=page.locator('#booking-dialog');await modal.getByRole('heading',{name:'予約を取り直しますか？'}).waitFor();
  assert.equal(await page.locator('[data-action="complete-bath"]').count(),0);
  await screenshot('question');await modal.getByRole('button',{name:'今はしない',exact:true}).click();
  await page.reload();await page.locator('.date-bar').waitFor();assert.equal(await page.locator('#booking-dialog[open]').count(),0);
  assert.equal((await state()).bookings[0].revision,original.revision);
  await page.locator('[data-action="rebook"]').click();await modal.getByRole('heading',{name:'おふろを予約し直す'}).waitFor();
  await modal.locator('#start').selectOption('1140');
  let first=true;await page.route('**/api/book',async route=>{
   if(first){first=false;await route.fetch();await route.fulfill({status:502,contentType:'text/html',body:'<html>gateway unavailable</html>'});}
   else await route.continue();
  });
  await modal.locator('#save-booking').click();await modal.getByText('サーバーの応答を読み込めませんでした。接続を確認して、もう一度お試しください。',{exact:true}).waitFor();
  const saved=(await state()).bookings[0];assert.notEqual(saved.revision,original.revision);
  await modal.locator('#save-booking').click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});
  assert.equal((await state()).bookings[0].revision,saved.revision);assert.equal(saved.start,1140);
  await screenshot('saved');
 });
 await scenario('ticket-fields',async({app,page,url,api,state,screenshot})=>{
  app.distributeItems({recipients:[1],kinds:['guard'],quantity:1,requestId:'browser-ticket-fields'});
  const gift=(await state()).rewards.gifts[0];await api('gifts/receive',{id:gift.id});
  await page.goto(url);await page.locator('[data-action="book"]').click();
  const modal=page.locator('#booking-dialog');await modal.locator('select[name="duration"]').selectOption('180');
  await modal.locator('[name="note"]').fill('時刻変更の相談なし');await modal.locator('[name="noNegotiation"]').check();
  await modal.locator('[name="ticket"]').selectOption('guard');
  assert.equal(await modal.locator('select[name="duration"]').inputValue(),'180');
  assert.equal(await modal.locator('[name="noNegotiation"]').isChecked(),true);
  assert.equal(await modal.locator('[name="note"]').inputValue(),'時刻変更の相談なし');
  await modal.locator('#start').selectOption('1080');await screenshot('form');
  await modal.locator('#save-booking').click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});
  const saved=(await state()).bookings[0];assert.equal(saved.duration,180);assert.equal(saved.noNegotiation,1);assert.equal(saved.ticket,'guard');
 },{maxDuration:240});
 await scenario('day-turn-toast',async({page,url,api,state})=>{
  await api('notification-preferences',{reservationTurn:true});
  await api('book',{day:'2026-11-04',start:1080,duration:30});
  await page.goto(url);await page.locator('.date-bar').waitFor();
  const response=page.waitForResponse(r=>r.url().includes('/api/state?day=2026-11-03'));
  await page.locator('[data-day="2026-11-03"]').click();await response;
  await page.getByRole('heading',{name:'11月3日(火)',exact:true}).waitFor();
  assert.ok(!(await page.locator('#toast').textContent()).includes('予約する番です'));
 });
 await scenario('expired-guide',async({page,context,url,navigate})=>{
  await page.goto(url);await page.locator('.date-bar').waitFor();await navigate('ヘルプ','.help-page');
  await page.getByRole('button',{name:'予約と事前希望',exact:true}).click();await page.locator('.guide-dialog[open]').waitFor();
  await context.request.post(url+'/api/logout',{data:{}});
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await page.locator('.member-button').first().waitFor();assert.equal(await page.locator('dialog[open]').count(),0);
 });
 await scenario('day-during-refresh',async({page,url})=>{
  await page.goto(url);await page.locator('.date-bar').waitFor();
  let release,seen;
  const held=new Promise(r=>release=r),requested=new Promise(r=>seen=r);
  let first=true;
  await page.route('**/api/state?day=2026-11-04',async route=>{
   if(first){first=false;const response=await route.fetch();seen();await held;await route.fulfill({response});}
   else await route.continue();
  });
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await requested;
  await page.locator('[data-day="2026-11-03"]').click();release();
  await page.getByRole('heading',{name:'11月3日(火)',exact:true}).waitFor({timeout:3000});
 });
 await scenario('booking-during-refresh',async({page,url,state})=>{
  await page.goto(url);await page.locator('.date-bar').waitFor();
  let release,seen;
  const held=new Promise(r=>release=r),requested=new Promise(r=>seen=r);let first=true;
  await page.route('**/api/state?day=2026-11-04',async route=>{
   if(first){first=false;const response=await route.fetch();seen();await held;await route.fulfill({response});}
   else await route.continue();
  });
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await requested;
  await page.locator('[data-action="book"]').click();await page.locator('#start').selectOption('1080');
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/book'));
  await page.locator('#save-booking').click();assert.equal((await saved).status(),200);release();
  await page.getByRole('heading',{name:'18:00 〜 18:30',exact:true}).waitFor({timeout:3000});
  assert.equal((await state()).bookings[0].start,1080);
 });
 await scenario('logout-during-refresh',async({page,url,navigate})=>{
  await page.goto(url);await page.locator('.date-bar').waitFor();
  await navigate('設定','#auto-wishes-form');
  let release,seen;
  const held=new Promise(r=>release=r),requested=new Promise(r=>seen=r);let first=true;
  await page.route('**/api/state?day=2026-11-04',async route=>{
   if(first){first=false;const response=await route.fetch();seen();await held;await route.fulfill({response});}
   else await route.continue();
  });
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await requested;
  await page.locator('[data-action="logout"]').click();await page.locator('.member-button').first().waitFor();
  // Wait for the held stale response's handler, then assert the login survives it.
  const stale=page.waitForResponse(r=>r.url().includes('/api/state?day=2026-11-04'));release();await stale;
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.ok(await page.locator('.member-button').count()>0);assert.equal(await page.locator('.date-bar').count(),0);
 });
 await scenario('morning-rebooking',async({page,url,api,time,screenshot})=>{
  await api('book',{day:'2026-11-04',start:1800,duration:30});time('2026-11-05T06:32:00');
  await page.goto(url);const modal=page.locator('#booking-dialog');
  await modal.getByRole('button',{name:'予約を取り直す',exact:true}).click();
  await modal.getByRole('heading',{name:'おふろを予約し直す',exact:true}).waitFor();
  await page.getByRole('heading',{name:'11月4日(水)',exact:true}).waitFor();
  assert.deepEqual(await modal.locator('#start option').evaluateAll(options=>options.map(o=>Number(o.value))),[1845]);
  await screenshot('previous-night');
 });
 await scenario('auto-settings-other-device',async({page,url,api,state,navigate})=>{
  const original=(await state()).autoWishes.days;
  await page.goto(url);await page.locator('.date-bar').waitFor();await navigate('設定','#auto-wishes-form');
  const form=page.locator('#auto-wishes-form');
  await form.locator('[name="weekday"]').selectOption('1');await form.locator('[name="mode"]').selectOption('reservation');
  await form.locator('[name="start"]').fill('18:15');await form.locator('[name="duration"]').selectOption('45');
  await form.locator('[name="note"]').fill('月曜の設定');
  // Another logged-in device saves Tuesday while this device is editing Monday.
  await api('auto-wishes',{days:original.map(d=>d.weekday===2?{...d,enabled:true,mode:'reservation',start:1140,duration:30,note:'別端末から保存'}:d)});
  await form.getByRole('button',{name:'設定する',exact:true}).click();await page.getByText('自動予約の設定を保存しました。',{exact:true}).waitFor();
  const days=(await state()).autoWishes.days;
  assert.deepEqual([days[1].mode,days[1].start,days[1].duration,days[1].note],['reservation',1095,45,'月曜の設定']);
  assert.deepEqual([days[2].mode,days[2].start,days[2].note],['reservation',1140,'別端末から保存']);
 });
 await scenario('boost-response-lost',async({app,page,url,api,state,navigate})=>{
  app.distributeItems({recipients:[1],kinds:['boost'],quantity:2,requestId:'browser-boost-lost-response'});
  await api('gifts/receive',{id:(await state()).rewards.gifts[0].id});
  await page.goto(url);await page.locator('.date-bar').waitFor();await navigate('持ち物','.inventory-page');
  await page.locator('[data-action="item-detail"][data-kind="boost"]').click();
  const modal=page.locator('#booking-dialog');let first=true;
  await page.route('**/api/items/boost',async route=>{
   if(first){first=false;await route.fetch();await route.fulfill({status:502,contentType:'text/html',body:'<html>Bad gateway</html>'});}
   else await route.continue();
  });
  await modal.getByRole('button',{name:'効果を有効にする',exact:true}).click();
  await page.getByText('サーバーの応答を読み込めませんでした。接続を確認して、もう一度お試しください。',{exact:true}).waitFor();
  await modal.getByRole('button',{name:'効果を有効にする',exact:true}).click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});
  let result=(await state()).rewards;assert.equal(result.wallet.find(x=>x.kind==='boost').quantity,1);assert.equal(result.boostRemaining,3);
  // A separate intentional activation still consumes a separate item.
  await page.locator('[data-action="item-detail"][data-kind="boost"]').click();
  await modal.getByRole('button',{name:'効果を有効にする',exact:true}).click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});
  result=(await state()).rewards;assert.equal(result.wallet.find(x=>x.kind==='boost').quantity,0);assert.equal(result.boostRemaining,6);
 });
 await scenario('unresponsive-server',async({page,url})=>{
  await page.addInitScript(()=>{
   const originalFetch=window.fetch;
   let hang=true;
   window.fetch=(url,options)=>{
    if(hang&&url==='/api/family'){
     hang=false;
     return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
    }
    return originalFetch(url,options);
   };
  });
  await page.goto(url,{waitUntil:'commit'});
  await page.getByRole('heading',{name:'接続できませんでした。',exact:true}).waitFor({timeout:20000});
  await page.getByText('サーバーの応答に時間がかかっています。接続を確認し、もう一度お試しください。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'もう一度読み込む',exact:true}).click();await page.locator('.date-bar').waitFor();
 });
 await scenario('gateway-response',async({page,url})=>{
  let first=true;await page.route('**/api/family',async route=>{
   if(first){first=false;await route.fulfill({status:502,contentType:'text/html',body:'<html>Bad gateway</html>'});}
   else await route.continue();
  });
  await page.goto(url);await page.getByRole('heading',{name:'接続できませんでした。',exact:true}).waitFor();
  await page.getByText('サーバーの応答を読み込めませんでした。接続を確認して、もう一度お試しください。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'もう一度読み込む',exact:true}).click();await page.locator('.date-bar').waitFor();
 });
} finally { await browser.close(); }
