import {readFileSync} from 'node:fs';
import {bathCalendar} from './bath-calendar.js';
import {slotDate} from './domain.js';
import {lastReportMinutes} from './completion-policy.js';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status})};
export function createRebooking({db,now,scheduleForDay,rewardSettings}) {
 db.exec(readFileSync(new URL('../migrations/0019_rebooking.sql',import.meta.url),'utf8'));
 function eligible(booking, member) {
  if(!booking || booking.member_id!==member)return false;
  const instant=now().getTime(),rule=scheduleForDay(booking.day);
  if(instant>=slotDate(booking.day,rule.bathEnd).getTime())return false;
  if(instant<=slotDate(booking.day,booking.start+booking.duration).getTime()+lastReportMinutes(rewardSettings())*60000)return false;
  if(db.prepare('SELECT 1 FROM bath_completions WHERE day=? AND member_id=?').get(booking.day,member))return false;
  const minute=(instant-slotDate(booking.day,0).getTime())/60000;
  const nextStart=Math.max(rule.bathStart,(Math.floor(minute/rule.step)+1)*rule.step);
  return nextStart<rule.bathEnd;
 }
 function check(day,member,revision) {
  const booking=db.prepare('SELECT * FROM bookings WHERE day=? AND member_id=?').get(day,member);
  if(typeof revision!=='string'||booking?.revision!==revision||!eligible(booking,member))
   fail('この予約は取り直せません。完了報告や予約の変更がないか確認してください。');
  return booking;
 }
 function offer(member) {
  const time=bathCalendar(now());
  for(const booking of db.prepare('SELECT * FROM bookings WHERE member_id=? AND day BETWEEN ? AND ? ORDER BY day DESC').all(member,time.yesterday,time.today)){
   if(!eligible(booking,member))continue;
   return {day:booking.day,revision:booking.revision,start:booking.start,duration:booking.duration,
    prompted:!!db.prepare('SELECT 1 FROM rebooking_prompts WHERE member_id=? AND revision=?').get(member,booking.revision)};
  }
  return null;
 }
 function decide(member,payload) {
  if(!payload||!['later','rebook'].includes(payload.decision)||typeof payload.day!=='string')fail('再予約の確認内容を確認してください。',400);
  check(payload.day,member,payload.revision);
  db.prepare('INSERT OR IGNORE INTO rebooking_prompts VALUES(?,?,?,?,?)').run(payload.revision,payload.day,member,payload.decision,now().toISOString());
  return {ok:true};
 }
 // Called inside the booking transaction; a failed replacement leaves everything intact.
 function archive(booking,newRevision) {
  check(booking.day,booking.member_id,booking.revision);
  db.prepare('INSERT INTO rebooking_history VALUES(?,?,?,?,?,?)').run(booking.revision,booking.day,booking.member_id,JSON.stringify(booking),newRevision,now().toISOString());
 }
 function wasApplied(day,member,payload,booking) {
  if(typeof payload.rebookRevision!=="string"||!booking)return false;
  const history=db.prepare('SELECT new_revision FROM rebooking_history WHERE old_revision=? AND day=? AND member_id=?').get(payload.rebookRevision,day,member);
  const note=payload.note===undefined?booking.note:payload.note;
  return history?.new_revision===booking.revision && payload.start===booking.start && payload.duration===booking.duration &&
   typeof note==='string' && note.trim()===booking.note && (payload.noNegotiation??!!booking.no_negotiation)===!!booking.no_negotiation && (payload.ticket??null)===(booking.ticket??null);
 }
 return {offer,check,decide,archive,wasApplied};
}
