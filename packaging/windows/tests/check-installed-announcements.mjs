import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=process.argv[2],data=process.argv[3];mkdirSync(data,{recursive:true});
const {createApp}=await import(pathToFileURL(join(root,'app/src/app.js')));
const {activateInstalledUpdate}=await import(pathToFileURL(join(root,'app/src/installed-update.js')));
const marker=readFileSync(join(root,'installed-update.json'),'utf8');assert.equal(JSON.parse(marker).previousVersion,'2.0.0');
const app=createApp({database:join(data,'synthetic.sqlite'),requireFamily:false});
try{
 assert.equal(activateInstalledUpdate(app,{installRoot:root,installed:true}),true);
 const entries=app.getAnnouncementsAdmin().entries;assert.equal(entries.length,1);assert.equal(entries[0].pages.length,3);assert.ok(entries[0].pages.every(p=>p.hasImage===1));
 assert.equal(existsSync(join(root,'installed-update.json')),false);
 writeFileSync(join(root,'installed-update.json'),marker);activateInstalledUpdate(app,{installRoot:root,installed:true});assert.equal(app.getAnnouncementsAdmin().entries.length,1);
 console.log('Installed upgrade: marker JSON, three bundled images, activation and duplicate suppression passed.');
}finally{app.close()}
