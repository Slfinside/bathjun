// Exercise the actual shipped EXE, configuration and bundled Node together.
// All data belongs to this synthetic fixture, never the runner's real profile.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {connect} from 'node:net';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const [root,profile]=process.argv.slice(2);
const portable=JSON.parse(readFileSync(join(root,'build-manifest.json'),'utf8')).distribution==='portable-local';
const data=join(profile,portable?'BathjunTestData':'BathjunData');
assert.equal(process.platform,'win32');
mkdirSync(data,{recursive:true});process.env.BATHJUN_DATA_DIR=data;
const {openApplication}=await import(pathToFileURL(join(root,'app/src/runtime.js')));
const app=openApplication();await app.setFamilyPassword('synthetic-startup-only');app.close();
// Reproduce an interrupted update: optional activation metadata must not abort boot.
writeFileSync(join(root,'installed-update.json'),JSON.stringify({version:'0.0.0',previousVersion:'0.0.0'}));
writeFileSync(join(data,'server-mode.json'),JSON.stringify({mode:'local'}));
const entry=join(root,portable?'start-local.cmd':'start-after-install.cmd');
const child=spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${entry}""`],{cwd:root,windowsVerbatimArguments:true,env:{...process.env,LOCALAPPDATA:profile,BATHJUN_NO_BROWSER:'1',PORT:'0'},stdio:['ignore','pipe','pipe']});
let output='',exit;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('exit',(code,signal)=>exit={code,signal});
async function command(name){
 const locator=JSON.parse(readFileSync(join(data,'panel.json'),'utf8'));
 return new Promise((resolve,reject)=>{const socket=connect('\\\\.\\pipe\\'+locator.name);let buffer='';socket.setTimeout(5000,()=>socket.destroy(Error('IPC timed out')));socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({token:locator.token,id:'startup-test',command:name})+'\n'));socket.on('data',b=>{buffer+=b;for(const line of buffer.split('\n').slice(0,-1)){const reply=JSON.parse(line);if(reply.id==='startup-test'){socket.destroy();resolve(reply);return}}});});
}
try{
 let state;
 for(let n=0;n<150;n++){
  if(exit)throw Error('Launcher exited before the UI was ready: '+JSON.stringify(exit)+'\n'+output);
  if(existsSync(join(data,'panel.json'))){const reply=await command('status');if(reply.state?.phase==='ready'){state=reply.state;break}}
  await delay(200);
 }
 assert.ok(state,'Server never became ready.\n'+output);
 await delay(3000);assert.equal(exit,undefined,'Launcher exited after start.\n'+output);
 const dashboard=await command('dashboard/get');assert.equal(dashboard.ok,true);
 const response=await fetch(state.url);assert.equal(response.status,200);
 await command('show');await delay(300);
 // UI existence is checked in PowerShell against the real child process/window.
 const window=execFileSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`$p = Get-Process -Name Bathjun-Server | Where-Object { $_.Path -eq $env:BATHJUN_EXPECTED_UI -and $_.MainWindowHandle -ne 0 }; if (-not $p) { throw 'Shipped management window is missing' }; $p | ForEach-Object { $_.MainWindowTitle }`],{encoding:'utf8',env:{...process.env,BATHJUN_EXPECTED_UI:join(root,'bin/Bathjun-Server.exe')}});
 assert.ok(window.trim(),'Management window is missing');
 assert.match(output,/更新のお知らせを読み込めませんでした/);
 assert.match(output,new RegExp('ふろじゅん v'+JSON.parse(readFileSync(join(root,'app/package.json'),'utf8')).version.replaceAll('.','\\.')));
 console.log(output);
 await command('stop');
 for(let n=0;n<50&&!exit;n++)await delay(100);
 assert.ok(exit,'Server did not stop');assert.equal(exit.code,0,output);
 console.log('Shipped Windows startup, live HTTP, dashboard IPC and clean shutdown passed.');
}finally{if(!exit)child.kill();}
