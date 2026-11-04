import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createHttpServer} from '../src/http.js';
const root=new URL('../public/fonts/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('source.json',root)));
test('共通フォントの通常・太字とライセンスを同梱し、各ファイルのハッシュを照合する',()=>{
 assert.match(readFileSync(new URL('OFL.txt',root),'utf8'),/SIL OPEN FONT LICENSE/);
 assert.equal(Object.keys(manifest.files).length,4);
 for(const [name,info] of Object.entries(manifest.files)){
  const data=readFileSync(new URL(name,root));assert.equal(data.length,info.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'),info.sha256);
 }
 const css=readFileSync(new URL('../public/style.css',import.meta.url),'utf8');
 assert.ok(readFileSync(new URL("../public/index.html",import.meta.url),"utf8").includes("/fonts/web.css"));
 assert.ok(css.includes('"Bathjun Sans", -apple-system'));
});
test('フォントも家族用の長いリンクで保護し、同一端末では繰り返し取得しない',async t=>{
 const token='a'.repeat(64),app={accessToken:()=>token};
 const {server}=createHttpServer(app,{privateLink:true});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 for(const [name,info] of Object.entries(manifest.files).filter(([n])=>n.endsWith('.woff2'))){
  const url=base+'/fonts/'+name;
  assert.equal((await fetch(url)).status,404);
  const r=await fetch(url,{headers:{cookie:'bath_gate='+token}});
  assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'font/woff2');assert.equal(r.headers.get('cache-control'),'private, max-age=31536000, immutable');
  assert.equal(createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'),info.sha256);
 }
});
