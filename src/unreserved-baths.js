import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {slotDate} from './domain.js';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status})};
export function migrateUnreservedBaths(db){
 db.exec(readFileSync(new URL('../migrations/0025_unreserved_baths.sql',import.meta.url),'utf8'));
}
export function unreservedBaths(db,day,member=null){
 return db.prepare('SELECT id,day,member_id AS memberId,start,duration,note,reported_at AS completedAt FROM unreserved_baths WHERE day=? AND (? IS NULL OR member_id=?) ORDER BY start,id').all(day,member,member).map(b=>({...b,revision:b.id,unreserved:true,archived:true}));
}
export function createUnreservedBaths({db,now,scheduleForDay,transaction,onCompleted,clientReportsAllowed}){
 function report(member,payload,source='client'){
  if(source!=='dashboard'&&!clientReportsAllowed())fail('クライアントからの入浴報告は無効です。ダッシュボードから報告してください。',403);
  const {day,start,duration,requestId}=payload||{},note=payload?.note??'';
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T12:00:00Z'))||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day||!Number.isInteger(start)||!Number.isInteger(duration)||duration<1||duration>1440||typeof note!=='string'||note.length>300||typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(requestId))fail('実際の開始・終了時刻と備考を確認してください。');
  return transaction(()=>{
   const prior=db.prepare('SELECT * FROM unreserved_baths WHERE request_id=?').get(requestId);
   if(prior){if(prior.member_id!==member)fail('この報告は利用できません。',403);if(prior.day!==day||prior.start!==start||prior.duration!==duration||prior.note!==note.trim())fail('送信中の報告内容が変わっています。開き直してください。',409);return {ok:true,id:prior.id};}
   if(!db.prepare('SELECT 1 FROM members WHERE id=? AND active=1').get(member))fail('報告するメンバーを確認してください。',403);
   const rule=scheduleForDay(day),end=slotDate(day,start+duration),instant=now();
   if(start<rule.bathStart||start>=rule.bathEnd)fail('開始時刻がこの日分の範囲に入りません。日付を確認してください。');
   if(end>instant)fail('実際に入浴を終えた時刻までを入力してください。');
   // Time inputs have minute precision; a bath crossing the day boundary can be recorded in its ending minute.
   const until=slotDate(day,Math.max(rule.bathEnd,start+duration+1));
   if(source!=='dashboard'&&instant>=until)fail('この日分の入浴報告の受付は終了しました。',409);
   const existing=db.prepare('SELECT id FROM unreserved_baths WHERE day=? AND member_id=? AND start=? AND duration=?').get(day,member,start,duration);
   if(existing)return {ok:true,id:existing.id};
   const id=randomBytes(16).toString('hex');
   db.prepare('INSERT INTO unreserved_baths VALUES(?,?,?,?,?,?,?,?,?)').run(id,requestId,day,member,start,duration,note.trim(),instant.toISOString(),source);
   onCompleted(member,day);
   return {ok:true,id};
  });
 }
 return {report,list:(day,member=null)=>unreservedBaths(db,day,member)};
}
