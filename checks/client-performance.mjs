import {chromium} from 'playwright-core';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const sourceRoot=process.env.BATHJUN_AUDIT_ROOT||fileURLToPath(new URL('..',import.meta.url));
const {createApp}=await import(pathToFileURL(join(sourceRoot,'src/app.js')).href);
const {createHttpServer}=await import(pathToFileURL(join(sourceRoot,'src/http.js')).href);
import {DEFAULT_SCHEDULE} from '../src/server-settings.js';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
const output=process.env.BATHJUN_AUDIT_OUTPUT||mkdtempSync(join(tmpdir(),'bathjun-performance-results-'));mkdirSync(output,{recursive:true});
const dir=mkdtempSync(join(tmpdir(),'bathjun-response-'));let clock=new Date('2026-11-01T08:00:00+09:00');
const app=createApp({database:dir+'/synthetic.sqlite',requireFamily:false,now:()=>clock,deliverPush:async()=>{}});
app.saveServerSettings({members:['A','B','C','D','E'].map(x=>({name:'利用者'+x,active:true})),schedule:{...DEFAULT_SCHEDULE,orderMode:'fixed'}});clock=new Date('2026-11-17T08:00:00+09:00');
const serverLogs=[];const measured={...app,handle:async(req,res)=>{const start=performance.now();res.once('finish',()=>serverLogs.push({path:req.url,ms:performance.now()-start}));return app.handle(req,res)}};
const {server}=createHttpServer(measured);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
const b=await chromium.launch({executablePath:process.env.BATHJUN_BROWSER_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const rows=[];
try{
 for(const profile of [{latency:0,cpu:1},{latency:150,cpu:4},{latency:300,cpu:4}].filter(p=>!process.env.BATHJUN_AUDIT_LATENCY||p.latency===Number(process.env.BATHJUN_AUDIT_LATENCY))){
  for(let sample=0;sample<3;sample++){
   const c=await b.newContext({viewport:{width:390,height:844},locale:'ja-JP',isMobile:true,hasTouch:true});const page=await c.newPage();
   const auth=await c.request.post(url+'/api/'+(rows.length===0?'register':'login'),{data:{memberId:1,password:'synthetic-only'}});if(!auth.ok())throw Error(await auth.text());
   await page.addInitScript(()=>{window.longTasks=[];new PerformanceObserver(list=>{for(const e of list.getEntries())window.longTasks.push({start:e.startTime,duration:e.duration})}).observe({entryTypes:['longtask']})});
   const cdp=await c.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:profile.latency,downloadThroughput:1250000,uploadThroughput:250000});await cdp.send('Emulation.setCPUThrottlingRate',{rate:profile.cpu});
   async function open(warm){await (warm?page.reload({waitUntil:'domcontentloaded'}):page.goto(url,{waitUntil:'domcontentloaded'}));await page.locator('.date-bar').waitFor();return page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const readyMs=performance.now();await document.fonts.ready;const visualReadyMs=performance.now();const resources=performance.getEntriesByType('resource');return{readyMs,visualReadyMs,encodedBytes:resources.reduce((n,r)=>n+r.encodedBodySize,0),transferBytes:resources.reduce((n,r)=>n+r.transferSize,0),api:resources.filter(r=>new URL(r.name).pathname.startsWith('/api/')).map(r=>({path:new URL(r.name).pathname,ms:r.duration,start:r.startTime,end:r.responseEnd})),longTasks:window.longTasks}})}
   const cold=await open(false),warm=await open(true),navigation=[];
   for(const [name,selector] of [['設定','.settings-page'],['持ち物','.inventory-page'],['ヘルプ','.help-page'],['入浴の報告','.reports-page'],['ホーム','.date-bar']]){
    await page.locator('.account-menu>summary').click();const start=await page.evaluate(()=>performance.now());await page.getByRole('navigation',{name:'メニュー'}).getByRole('button',{name,exact:true}).click();await page.locator(selector).waitFor();const result=await page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()});navigation.push({name,ms:result-start});
   }
   const start=await page.evaluate(()=>performance.now());await page.locator('[data-action="book"]').click();await page.locator('#booking-dialog[open]').waitFor();const bookingMs=await page.evaluate(()=>performance.now())-start;
   const row={...profile,sample,cold,warm,navigation,bookingMs};rows.push(row);console.log(JSON.stringify({latency:profile.latency,cpu:profile.cpu,sample,cold:Math.round(cold.readyMs),warm:Math.round(warm.readyMs),coldKB:Math.round(cold.encodedBytes/1000),navigation:navigation.map(r=>[r.name,Math.round(r.ms)]),bookingMs:Math.round(bookingMs)}));await c.close();
  }
 }
 writeFileSync(output+'/'+(process.env.BATHJUN_AUDIT_NAME||'baseline')+'.json',JSON.stringify({sourceRoot,conditions:'Synthetic five-member data; Chromium; RTT emulation; browser CPU throttling only; localhost server on cloud host; not a physical iPhone or low-power server benchmark',rows,serverLogs},null,2));
 console.log('Saved synthetic benchmark results:',output);
}finally{await b.close();await new Promise(r=>server.close(r));app.close();rmSync(dir,{recursive:true,force:true})}
