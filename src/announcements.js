import {readFileSync,statSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
const id=()=>randomBytes(16).toString('hex');
const invalid=message=>{throw Object.assign(Error(message),{status:400})};
function imageFile(path){
  if(typeof path!=='string'||!path)return null;
  const size=statSync(path).size;if(size>2*1024*1024)invalid('画像は1枚2MBまでです。');
  const image=readFileSync(path);
  const type=image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':image[0]===255&&image[1]===216&&image[2]===255?'image/jpeg':null;
  if(!type)invalid('画像はPNGまたはJPEGを選んでください。');
  return {image,type};
}
export function createAnnouncements({db,now,onChanged=()=>{}}){
  db.exec(readFileSync(new URL('../migrations/0023_announcements.sql',import.meta.url),'utf8'));
  const transaction=fn=>{db.exec('SAVEPOINT announcements');try{const result=fn();db.exec('RELEASE announcements');return result}catch(error){db.exec('ROLLBACK TO announcements; RELEASE announcements');throw error}};
  function publishDue(){db.prepare("UPDATE announcements SET state='published',published_at=?,updated_at=? WHERE state='scheduled' AND scheduled_at<=?").run(now().toISOString(),now().toISOString(),now().getTime())}
  function admin(){publishDue();return {entries:db.prepare('SELECT a.*, (SELECT COUNT(*) FROM announcement_receipts r WHERE r.announcement_id=a.id) AS readCount FROM announcements a ORDER BY created_at DESC,id LIMIT 50').all().map(a=>({...a,pages:db.prepare('SELECT id,title,text,image IS NOT NULL AS hasImage FROM announcement_pages WHERE announcement_id=? ORDER BY position').all(a.id)}))}}
  function save(body,bundleVersion=null){
    if(!body||!Array.isArray(body.pages)||body.pages.length<1||body.pages.length>10)invalid('お知らせは1〜10ページで作成してください。');
    if(typeof body.label!=='string'||!body.label.trim()||body.label.length>100)invalid('管理用の名前を100文字以内で入力してください。');
    if(!['draft','scheduled','published'].includes(body.state))invalid('配信方法を選んでください。');
    if(body.state==='scheduled'&&(!Number.isSafeInteger(body.scheduledAt)||body.scheduledAt<=now().getTime()||body.scheduledAt>now().getTime()+366*86400000))invalid('予約配信は1年以内の、これからの日時を選んでください。');
    const previous=body.id?db.prepare('SELECT * FROM announcements WHERE id=?').get(body.id):null;
    if(body.id&&(!previous||!['draft','scheduled'].includes(previous.state)))invalid('配信済みのお知らせは編集できません。新しく作成してください。');
    const pages=body.pages.map(page=>{
      if(!page||typeof page.title!=='string'||!page.title.trim()||page.title.length>100||typeof page.text!=='string'||page.text.length>3000)invalid('各ページのタイトルは100文字、本文は3000文字以内にしてください。');
      const old=previous&&typeof page.id==='string'?db.prepare('SELECT image,image_type AS type FROM announcement_pages WHERE id=? AND announcement_id=?').get(page.id,previous.id):null;
      const picture=page.removeImage?null:page.imagePath?imageFile(page.imagePath):old?.image?{image:old.image,type:old.type}:null;
      return {...page,picture};
    });
    const announcementId=previous?.id||id(),stamp=now().toISOString();
    transaction(()=>{
      if(previous){db.prepare('DELETE FROM announcement_pages WHERE announcement_id=?').run(announcementId);db.prepare('UPDATE announcements SET label=?,state=?,scheduled_at=?,published_at=?,updated_at=? WHERE id=?').run(body.label.trim(),body.state,body.state==='scheduled'?body.scheduledAt:null,body.state==='published'?stamp:null,stamp,announcementId)}
      else db.prepare('INSERT INTO announcements VALUES(?,?,?,?,?,?,?,?)').run(announcementId,body.label.trim(),body.state,body.state==='scheduled'?body.scheduledAt:null,body.state==='published'?stamp:null,stamp,stamp,bundleVersion);
      pages.forEach((page,i)=>db.prepare('INSERT INTO announcement_pages VALUES(?,?,?,?,?,?,?)').run(id(),announcementId,i,page.title.trim(),page.text,page.picture?.image||null,page.picture?.type||null));
    });onChanged();return admin();
  }
  function archive(value){
    if(!db.prepare("UPDATE announcements SET state='archived',updated_at=? WHERE id=? AND state!='archived'").run(now().toISOString(),value?.id).changes)invalid('お知らせが見つかりません。');
    onChanged();return admin();
  }
  function pending(member){publishDue();return db.prepare("SELECT a.id,a.label,(SELECT COUNT(*) FROM announcement_pages p WHERE p.announcement_id=a.id) AS pageCount FROM announcements a WHERE a.state='published' AND NOT EXISTS(SELECT 1 FROM announcement_receipts r WHERE r.announcement_id=a.id AND r.member_id=?) ORDER BY a.published_at,a.id").all(member)}
  function get(value,member){if(typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))invalid('お知らせを確認してください。');publishDue();const row=db.prepare("SELECT id,label FROM announcements WHERE id=? AND state='published'").get(value);if(!row)throw Object.assign(Error('お知らせが見つかりません。'),{status:404});return {...row,memberId:member||null,seen:member?!!db.prepare('SELECT 1 FROM announcement_receipts WHERE announcement_id=? AND member_id=?').get(row.id,member):false,pages:db.prepare('SELECT id,title,text,image IS NOT NULL AS hasImage FROM announcement_pages WHERE announcement_id=? ORDER BY position').all(row.id).map(p=>({...p,imageUrl:p.hasImage?'/api/announcements/image/'+p.id:null}))}}
  function picture(pageId){publishDue();return db.prepare("SELECT p.image,p.image_type FROM announcement_pages p JOIN announcements a ON a.id=p.announcement_id WHERE p.id=? AND a.state='published'").get(pageId)}
  function seen(member,body){if(body?.memberId!==undefined&&body.memberId!==member)throw Object.assign(Error('ログインしているメンバーが変わりました。読み込み直してください。'),{status:409});get(body?.id);if(typeof body.skipped!=='boolean')invalid('お知らせの確認内容を確認してください。');db.prepare('INSERT OR IGNORE INTO announcement_receipts VALUES(?,?,?,?)').run(body.id,member,now().toISOString(),body.skipped?1:0);return {ok:true}}
  function activate(bundle,previousVersion){
    if(!bundle||typeof bundle.version!=='string'||!/^\d+\.\d+\.\d+$/.test(bundle.version)||!/^\d+\.\d+\.\d+(?:-(?:rc|beta)[\d.]*)?$/.test(previousVersion)||previousVersion===bundle.version)invalid('更新のお知らせ情報を確認できませんでした。');
    transaction(()=>{if(db.prepare('SELECT 1 FROM installed_update_history WHERE version=?').get(bundle.version))return;
      save({label:bundle.label,state:'published',pages:bundle.pages},bundle.version);
      db.prepare('INSERT INTO installed_update_history VALUES(?,?,?)').run(bundle.version,previousVersion,now().toISOString());
    });return {ok:true};
  }
  return {admin,save,archive,pending,get,picture,seen,activate,publishDue,dueAt:()=>db.prepare("SELECT MIN(scheduled_at) AS due FROM announcements WHERE state='scheduled'").get().due};
}
