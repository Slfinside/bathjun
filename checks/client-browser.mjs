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
async function scenario(name,fn,{maxDuration=90,hostname='127.0.0.1'}={}){
 const directory=mkdtempSync(join(tmpdir(),'bathjun-browser-'));
 let clock=new Date('2026-11-02T08:00:00+09:00');
 const app=createApp({database:join(directory,'test.sqlite'),requireFamily:false,now:()=>clock,deliverPush:async()=>{}});
 app.saveServerSettings({members:[{name:'利用者A',active:true},{name:'利用者B',active:true}],schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed',maxDuration}});
 clock=new Date('2026-11-04T08:00:00+09:00');
 const {server}=createHttpServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://${hostname}:${server.address().port}`;
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
 await scenario('announcements',async({app,page,url,state,screenshot,context})=>{
  app.saveAnnouncement({label:'画面内お知らせのテスト',state:'published',pages:[{title:'はじめのお知らせ',text:'説明は本文として表示します。',imagePath:new URL('../release-announcements/items.png',import.meta.url).pathname},{title:'<script>テキストです</script>',text:'2ページ目の説明'},{title:'最後のページ',text:'お知らせの終わりです。'}]});
  await page.goto(url);const modal=page.locator('.announcement-dialog[open]');await modal.waitFor();await modal.locator('img').evaluate(img=>img.decode());
  assert.equal(await modal.locator('.announcement-counter').innerText(),'1 / 3');assert.equal(await modal.locator('img').isVisible(),true);
  const names=await modal.evaluate(el=>[...el.children].map(child=>child.tagName));assert.deepEqual(names,['SPAN','H2','IMG','P','BUTTON','BUTTON']);
  await screenshot('first');for(const size of [{width:320,height:568},{width:390,height:844},{width:844,height:390},{width:1280,height:800}]){
   await page.setViewportSize(size);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   assert.ok(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth));const rect=await modal.boundingBox();assert.ok(Math.abs(rect.x+rect.width/2-size.width/2)<=2,'Notice must be horizontally centered');assert.ok(Math.abs(rect.y+rect.height/2-size.height/2)<=2,'Notice must be vertically centered');
   await screenshot('center-'+size.width+'x'+size.height);
  }
  await modal.getByRole('button',{name:'次へ',exact:true}).click();await modal.getByRole('heading',{name:'<script>テキストです</script>',exact:true}).waitFor();assert.equal(await modal.locator('script').count(),0);assert.equal(await modal.locator('img').isVisible(),false);assert.equal(await modal.locator('.announcement-counter').innerText(),'2 / 3');
  await modal.getByRole('button',{name:'次へ',exact:true}).click();await modal.getByRole('heading',{name:'最後のページ'}).waitFor();await screenshot('last');const ack=page.waitForResponse(r=>r.url().endsWith('/api/announcements/seen'));await modal.getByRole('button',{name:'閉じる',exact:true}).click();await ack;assert.equal((await state()).announcements.length,0);await page.reload();await page.locator('.date-bar').waitFor();assert.equal(await page.locator('.announcement-dialog[open]').count(),0);
 });
 await scenario('announcement-long-centered',async({app,page,url,state,screenshot})=>{
  await page.setViewportSize({width:320,height:480});app.saveAnnouncement({label:'長いお知らせ',state:'published',pages:[{title:'長いお知らせも中央に表示',text:'お知らせの本文を、枠の中でスクロールして確認できます。'.repeat(50)}]});
  await page.goto(url);const modal=page.locator('.announcement-dialog[open]');await modal.waitFor();await page.evaluate(()=>window.scrollTo(0,1000));
  const rect=await modal.boundingBox();assert.ok(Math.abs(rect.x+rect.width/2-160)<=2);assert.ok(Math.abs(rect.y+rect.height/2-240)<=2);
  assert.ok(rect.height<=432.5);assert.ok(await modal.evaluate(el=>el.scrollHeight>el.clientHeight));await screenshot('mobile');
  const ack=page.waitForResponse(r=>r.url().endsWith('/api/announcements/seen'));await modal.getByRole('button',{name:'閉じる',exact:true}).click();await ack;assert.equal((await state()).announcements.length,0);
 });
 await scenario('announcement-skip-logout',async({app,page,url,api,state})=>{
  app.saveAnnouncement({label:'スキップ',state:'published',pages:[{title:'最初',text:'最初です'},{title:'次',text:'次です'}]});await page.goto(url);const modal=page.locator('.announcement-dialog[open]');await modal.waitFor();const ack=page.waitForResponse(r=>r.url().endsWith('/api/announcements/seen'));await modal.getByRole('button',{name:'スキップする'}).click();await ack;assert.equal((await state()).announcements.length,0);
  app.saveAnnouncement({label:'ログアウト',state:'published',pages:[{title:'ログアウト前',text:'説明'}]});await page.reload();await modal.waitFor();await api('logout',{});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await page.locator('.member-button').first().waitFor();assert.equal(await page.locator('.announcement-dialog[open]').count(),0);
 });
 await scenario('bath-complete-status',async({app,page,url,api,state,time,screenshot})=>{
  app.saveRewardSettings({...app.getRewardsAdmin().settings,clientReportEnabled:true});await api('book',{day:'2026-11-04',start:1080,duration:30});time('2026-11-04T18:05:00');await page.goto(url);
  await page.locator('.reservation[data-action="report-entry"]').click();const modal=page.locator('#booking-dialog');await modal.getByRole('heading',{name:'入浴の報告',exact:true}).waitFor();await modal.getByRole('button',{name:'完了を報告',exact:true}).click();await page.locator('.reservation .outcome-label').getByText('完了',{exact:true}).waitFor();assert.ok((await state()).bookings[0].completedAt);await screenshot('complete');
 });
 await scenario('bath-missed-rebook',async({page,url,api,state,time,screenshot})=>{
  await api('book',{day:'2026-11-04',start:1080,duration:60});time('2026-11-04T18:10:00');await page.goto(url);await page.locator('[data-action="not-bathed"]').click();const modal=page.locator('#booking-dialog');await modal.getByRole('heading',{name:'入っていないと報告しますか？'}).waitFor();await modal.getByRole('button',{name:'キャンセル',exact:true}).click();assert.equal((await state()).bookings[0].notBathedAt,null);
  await page.locator('[data-action="not-bathed"]').click();const done=page.waitForResponse(r=>r.url().endsWith('/api/not-bathed'));await modal.getByRole('button',{name:'入っていないと確定',exact:true}).click();await done;await page.locator('.reservation.not-bathed').waitFor();await screenshot('missed');
  await page.locator('[data-action="rebook"]').click();await modal.getByRole('heading',{name:'おふろを予約し直す'}).waitFor();await modal.locator('#start').selectOption('1095');await modal.locator('#save-booking').click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});assert.equal(await page.locator('.reservation.not-bathed').count(),1);assert.equal(await page.locator('.reservation').count(),2);assert.equal((await state()).bookingHistory.length,1);await page.locator('.reservation.not-bathed').scrollIntoViewIfNeeded();await screenshot('rebooked');
 });
 await scenario('late-bath-report',async({app,page,url,api,navigate,state,time,screenshot})=>{
  app.saveRewardSettings({...app.getRewardsAdmin().settings,clientReportEnabled:true});await api('book',{day:'2026-11-04',start:1080,duration:30});time('2026-11-10T12:00:00');await page.goto(url);await page.locator('.date-bar').waitFor();await navigate('入浴の報告','.reports-page');await page.getByRole('button',{name:'入浴を報告する',exact:true}).click();const modal=page.locator('#booking-dialog');await modal.getByRole('button',{name:'完了を報告',exact:true}).click();await page.getByText('未報告の予約はありません。',{exact:true}).waitFor();await screenshot('reported');
 });
 await scenario('report-during-lazy-load',async({app,page,url,api,navigate,time,state})=>{
  app.saveRewardSettings({...app.getRewardsAdmin().settings,clientReportEnabled:true});await api('book',{day:'2026-11-04',start:1080,duration:30});time('2026-11-05T08:00:00');await api('book',{day:'2026-11-05',start:1080,duration:60});time('2026-11-05T18:10:00');await page.goto(url);await page.locator('.date-bar').waitFor();await navigate('入浴の報告','.reports-page');
  let release,seen;const held=new Promise(r=>release=r),requested=new Promise(r=>seen=r);await page.route('**/bath-reports.js',async route=>{seen();await held;await route.continue();});
  const entries=page.locator('.report-history-entry');await entries.nth(0).getByRole('button',{name:'入浴を報告する'}).click();await requested;await entries.nth(1).getByRole('button',{name:'入浴を報告する'}).click();release();
  const modal=page.locator('#booking-dialog');await modal.getByRole('heading',{name:'入浴の報告',exact:true}).waitFor();assert.match(await modal.innerText(),/2026-11-04分/);await modal.getByRole('button',{name:'完了を報告',exact:true}).click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});assert.ok((await state('2026-11-04')).bookings[0].completedAt);assert.equal((await state('2026-11-05')).bookings[0].completedAt,null);
 });
 await scenario('duration-only',async({page,url,state,screenshot})=>{
  await page.goto(url);await page.locator('[data-action="book"]').click();
  const modal=page.locator('#booking-dialog');await modal.locator('[name="untimed"]').check();
  assert.equal(await modal.locator('#start').isVisible(),false);
  assert.equal(await modal.locator('.end-summary').isVisible(),false);
  assert.equal(await modal.locator('.negotiation-choice').isVisible(),false);
  await modal.locator('[name="duration"][value="45"]').check();await modal.locator('[name="note"]').fill('今日は少しゆっくり');
  await screenshot('form');await modal.getByRole('button',{name:'使う時間を共有する'}).click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});
  let data=await state();assert.equal(data.bookings.length,0);assert.equal(data.wishes[0].start,null);assert.equal(data.wishes[0].duration,45);
  await page.reload();await page.locator('.untimed-plans').waitFor();await screenshot('shared');
  assert.ok((await page.locator('.untimed-plans').innerText()).includes('45分'));
  for(const width of [320,1200]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.locator('[data-action="book"]').click();assert.equal(await modal.locator('[name="untimed"]').isChecked(),true);
  await modal.locator('[name="untimed"]').uncheck();await modal.locator('#start').selectOption('1080');await modal.locator('#save-booking').click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});
  data=await state();assert.equal(data.wishes.length,0);assert.equal(data.bookings[0].start,1080);assert.equal(data.bookings[0].duration,45);
 });
 await scenario('duration-only-before-turn',async({page,url,api,state})=>{
  await api('logout',{});await api('register',{memberId:2,password:'test-only'});
  await page.goto(url);await page.locator('[data-action="wish"]').click();const modal=page.locator('#booking-dialog');
  await modal.locator('[name="untimed"]').check();await modal.locator('#save-booking').click();await page.locator('#booking-dialog[open]').waitFor({state:'hidden'});
  assert.equal((await state()).wishes[0].start,null);await page.locator('[data-action="wish"]').click();assert.equal(await modal.locator('[name="untimed"]').isChecked(),true);
 });
 await scenario('rebooking',async({app,page,context,url,api,state,time,screenshot})=>{
  assert.equal(app.getRewardsAdmin().settings.clientReportEnabled,false);
  await api('book',{day:'2026-11-04',start:1080,duration:30});const original=(await state()).bookings[0];
  time('2026-11-04T18:32:00');await page.goto(url);
  const modal=page.locator('#booking-dialog');await modal.getByRole('heading',{name:'入浴の報告'}).waitFor();
  assert.equal(await page.locator('[data-action="complete-bath"]').count(),0);
  await screenshot('question');await modal.getByRole('button',{name:'後で報告する',exact:true}).click();
  await page.reload();await page.locator('.date-bar').waitFor();assert.equal(await page.locator('#booking-dialog[open]').count(),0);
  assert.equal((await state()).bookings[0].revision,original.revision);
  await page.locator('[data-action="not-bathed"]').click();const nonEntry=page.waitForResponse(r=>r.url().endsWith('/api/not-bathed'));await modal.getByRole('button',{name:'入っていないと確定',exact:true}).click();await nonEntry;
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
  await modal.getByRole('button',{name:'入っていない',exact:true}).click();const ack=page.waitForResponse(r=>r.url().endsWith('/api/not-bathed'));await modal.getByRole('button',{name:'入っていないと確定',exact:true}).click();await ack;await page.locator('[data-action="rebook"]').click();
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
 const passkeyExpiry=async({page,context,url,api,state,navigate},deferList=false,switchAccount=false)=>{
  await api('register',{memberId:2,password:'synthetic-member-b'});await api('login',{memberId:1,password:'test-only'});
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(url);await page.locator('.date-bar').waitFor();await navigate('設定','#auto-wishes-form');
  await page.locator('[data-action="passkey-register"]').click();
  await page.getByText('パスキーを登録しました。次回から合い言葉や名前の入力を省略できます。',{exact:true}).waitFor();
  assert.equal((await state()).passkeyCount,1);
  let releaseList,seenList;
  if(deferList){
   const held=new Promise(r=>releaseList=r);seenList=new Promise(resolve=>{
    void page.route('**/api/passkey/list',async route=>{const response=await route.fetch();resolve();await held;await route.fulfill({response});});
   });
  }
  await page.locator('[data-action="passkey-manage"]').click();
  if(deferList)await seenList;else await page.locator('.passkey-list li').waitFor();
  if(switchAccount){
   await api('login',{memberId:2,password:'synthetic-member-b'});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
   await page.locator('.profile-name').filter({hasText:'利用者B'}).waitFor();
  }else{
   await context.request.post(url+'/api/logout',{data:{}});await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
   await page.locator('[data-member="2"]').waitFor();
   if(deferList){const response=page.waitForResponse(r=>r.url().endsWith('/api/passkey/list'));releaseList();await response;await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
   await page.locator('[data-member="2"]').click();await page.locator('#password').fill('synthetic-member-b');
   await page.locator('#login-form button[type="submit"]').click();await page.locator('.date-bar').waitFor();
  }
  await navigate('設定','#auto-wishes-form');assert.equal(await page.locator('.passkey-list li').count(),0);
  // Authenticate with the first member's actual virtual passkey after logging out B.
  await page.locator('[data-action="logout"]').click();await page.locator('[data-action="passkey-login"]').click();
  await page.locator('.date-bar').waitFor();assert.equal((await state()).me.id,1);
 };
 await scenario('passkey-after-expiry',f=>passkeyExpiry(f),{hostname:'localhost'});
 await scenario('passkey-list-inflight-expiry',f=>passkeyExpiry(f,true),{hostname:'localhost'});
 await scenario('passkey-shared-session-switch',f=>passkeyExpiry(f,false,true),{hostname:'localhost'});
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
