import {readFileSync,unlinkSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
export function activateInstalledUpdate(app,{installed=false,installRoot=root}={}){
  if(!installed)return false;
  const markerPath=join(installRoot,'installed-update.json');
  let marker;try{marker=JSON.parse(readFileSync(markerPath,'utf8'))}catch(error){if(error.code==='ENOENT')return false;throw error}
  const version=JSON.parse(readFileSync(join(installRoot,'app/package.json'),'utf8')).version;
  if(marker.version!==version)throw Error('インストールされた更新情報とバージョンが一致しません。');
  const path=join(installRoot,'app/release-announcements',version+'.json');
  const bundle=JSON.parse(readFileSync(path,'utf8'));
  if(bundle.version!==version)throw Error('同梱のお知らせのバージョンが一致しません。');
  bundle.pages=bundle.pages.map(page=>{
    if(page.image && (!/^[a-zA-Z0-9_-]+\.(png|jpg)$/.test(page.image)))throw Error('同梱画像のパスを確認できませんでした。');
    return {...page,imagePath:page.image?resolve(installRoot,'app/release-announcements',page.image):null};
  });
  app.activateUpdateAnnouncements(bundle,marker.previousVersion);
  unlinkSync(markerPath);return true;
}
export function installedLaunchMode(directory){try{return JSON.parse(readFileSync(join(directory,'server-mode.json'),'utf8')).mode==='local'?'local':'public'}catch{return 'public'}}
export function rememberLaunchMode(directory,mode){writeFileSync(join(directory,'server-mode.json'),JSON.stringify({mode}),{mode:0o600})}
