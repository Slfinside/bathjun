import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {activateInstalledUpdateSafely} from '../src/installed-update.js';
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url))).version;
function temporary(t){const dir=mkdtempSync(join(tmpdir(),'bathjun-startup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir}
test('the Windows entry point prints its installed version before a startup failure',t=>{
 const directory=temporary(t);
 const result=spawnSync(process.execPath,['src/windows-launcher.js','local'],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env,BATHJUN_DATA_DIR:directory,BATHJUN_AUTOSTART:'1',BATHJUN_NO_BROWSER:'1'},timeout:15000});
 assert.equal(result.error,undefined);assert.equal(result.status,1);assert.match(result.stdout,new RegExp('ふろじゅん v'+version.replaceAll('.','\\.')));assert.match(result.stderr,/合い言葉/);
});
test('the entry point also retains the version and error when application imports fail',t=>{
 const root=temporary(t);mkdirSync(join(root,'src'));writeFileSync(join(root,'package.json'),JSON.stringify({version,type:'module'}));copyFileSync(new URL('../src/windows-launcher.js',import.meta.url),join(root,'src/windows-launcher.js'));
 const result=spawnSync(process.execPath,[join(root,'src/windows-launcher.js')],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,1);assert.match(result.stdout,/ふろじゅん v/);assert.match(result.stderr,/ERR_MODULE_NOT_FOUND/);
});
test('a broken or stale update announcement cannot abort startup or consume the pending marker',t=>{
 const root=temporary(t);mkdirSync(join(root,'app/release-announcements'),{recursive:true});writeFileSync(join(root,'app/package.json'),JSON.stringify({version}));const marker=join(root,'installed-update.json');let errors=[];let activated=0;const app={activateUpdateAnnouncements(){activated++}};
 writeFileSync(marker,'{broken');assert.equal(activateInstalledUpdateSafely(app,{installed:true,installRoot:root},e=>errors.push(e)),false);assert.equal(activated,0);assert.equal(existsSync(marker),true);
 writeFileSync(marker,JSON.stringify({version:'1.0.0',previousVersion:'0.9.0'}));assert.equal(activateInstalledUpdateSafely(app,{installed:true,installRoot:root},e=>errors.push(e)),false);assert.equal(activated,0);
 writeFileSync(marker,JSON.stringify({version,previousVersion:'2.0.0'}));assert.equal(activateInstalledUpdateSafely(app,{installed:true,installRoot:root},e=>errors.push(e)),false);assert.equal(errors.length,3);
 writeFileSync(join(root,'app/release-announcements',version+'.json'),JSON.stringify({version,pages:[{title:'test'}]}));assert.equal(activateInstalledUpdateSafely(app,{installed:true,installRoot:root},e=>errors.push(e)),true);assert.equal(activated,1);assert.equal(existsSync(marker),false);
});
