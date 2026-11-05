import {getNotificationPreferences} from './notification-preferences.js';
import {readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {slotDate} from './domain.js';

export function createBookingReminders({db,now,deliverPush,familyConfig,onQueued,isClosed}) {
  db.exec(readFileSync(new URL('../migrations/0007_booking_reminders.sql',import.meta.url),'utf8'));

  if(!db.prepare('PRAGMA table_info(booking_reminders)').all().some(column=>column.name==='lead_minutes'))db.exec('ALTER TABLE booking_reminders ADD COLUMN lead_minutes INTEGER NOT NULL DEFAULT 10');

  function syncMember(day,memberId) {
    const preferences=getNotificationPreferences(db,memberId);
    const booking=db.prepare('SELECT b.start FROM bookings b JOIN members m ON m.id=b.member_id WHERE b.day=? AND b.member_id=? AND m.active=1').get(day,memberId);
    const startAt=booking?slotDate(day,booking.start).getTime():0;
    const existing=db.prepare('SELECT endpoint,start,sent,lead_minutes FROM booking_reminders WHERE day=? AND member_id=?').all(day,memberId);
    let changed=0;
    if(!booking||startAt<=now().getTime()) {
      if(existing.length)changed=db.prepare('DELETE FROM booking_reminders WHERE day=? AND member_id=?').run(day,memberId).changes;
    } else if(!preferences.bathReminder) {
      changed=db.prepare('DELETE FROM booking_reminders WHERE day=? AND member_id=? AND (sent=0 OR start!=?)').run(day,memberId,booking.start).changes;
    } else {
      if(existing.some(job=>job.start!==booking.start))changed=db.prepare('DELETE FROM booking_reminders WHERE day=? AND member_id=? AND start!=?').run(day,memberId,booking.start).changes;
      changed+=db.prepare('DELETE FROM booking_reminders WHERE day=? AND member_id=? AND sent=0 AND lead_minutes!=?').run(day,memberId,preferences.reminderMinutes).changes;
      const subscriptions=db.prepare('SELECT p.endpoint FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.member_id=? AND s.expires>?').all(memberId,now().getTime());
      for(const sub of subscriptions) {
        if(existing.some(job=>job.endpoint===sub.endpoint&&job.start===booking.start&&(job.sent||job.lead_minutes===preferences.reminderMinutes)))continue;
        changed+=db.prepare('INSERT OR IGNORE INTO booking_reminders(id,endpoint,day,member_id,start,next_attempt,lead_minutes) VALUES(?,?,?,?,?,?,?)').run(randomBytes(16).toString('hex'),sub.endpoint,day,memberId,booking.start,Math.max(now().getTime(),startAt-preferences.reminderMinutes*60000),preferences.reminderMinutes).changes;
      }
    }
    if(changed)onQueued();
  }
  function syncDay(day) {
    // Include cancelled/deferred reservations to delete their old jobs.
    const ids=db.prepare('SELECT member_id FROM bookings WHERE day=? UNION SELECT member_id FROM booking_reminders WHERE day=?').all(day,day);
    for(const row of ids)syncMember(day,row.member_id);
  }
  function restore(memberId=null) {
    const rows=memberId===null?db.prepare('SELECT DISTINCT day,member_id FROM bookings').all():db.prepare('SELECT day,member_id FROM bookings WHERE member_id=?').all(memberId);
    for(const row of rows)syncMember(row.day,row.member_id);
  }
  async function flush() {
    const jobs=db.prepare('SELECT r.id FROM booking_reminders r WHERE r.sent=0 AND r.next_attempt<=? ORDER BY r.next_attempt LIMIT 20').all(now().getTime());
    for (const queuedJob of jobs) {
      if (isClosed()) return;
      const job = db.prepare('SELECT r.*,p.subscription_json,s.expires,p.member_id AS subscription_member FROM booking_reminders r JOIN push_subscriptions p ON p.endpoint=r.endpoint JOIN sessions s ON s.token_hash=p.session_hash WHERE r.sent=0 AND r.next_attempt<=? AND r.id=?').get(now().getTime(), queuedJob.id);
      if (!job) continue;
      const booking=db.prepare('SELECT b.start,m.name,m.active FROM bookings b JOIN members m ON m.id=b.member_id WHERE b.day=? AND b.member_id=?').get(job.day,job.member_id);
      const startAt=slotDate(job.day,job.start).getTime();
      if(!getNotificationPreferences(db,job.member_id).bathReminder||job.expires<=now().getTime()||job.subscription_member!==job.member_id||!booking||!booking.active||booking.start!==job.start||startAt<=now().getTime()) {
        db.prepare('DELETE FROM booking_reminders WHERE id=?').run(job.id);continue;
      }
      const minutes=Math.ceil((startAt-now().getTime())/60000);
      const time=`${job.start>=1440?'翌':''}${String(Math.floor(job.start/60)%24).padStart(2,'0')}:${String(job.start%60).padStart(2,'0')}`;
      const config=familyConfig();
      try {
        await deliverPush(JSON.parse(job.subscription_json),{
          title:'もうすぐおふろの時間です ♨',
          body:`${booking.name}さん、${time}からのおふろまで、あと約${minutes}分です。`,
          tag:`bath-reminder-${job.day}-${job.member_id}`,day:job.day,url:'/'
        },{publicKey:config.vapid_public,privateKey:config.vapid_private},{ttl:Math.max(1,Math.floor((startAt-now().getTime())/1000))});
        if(isClosed())return;
        // Changing only the lead time may recreate this job during delivery.
        // A different bath start still needs its own notification.
        db.prepare('UPDATE booking_reminders SET sent=1 WHERE endpoint=? AND day=? AND member_id=? AND start=?').run(job.endpoint,job.day,job.member_id,job.start);
      }catch(error) {
        if(isClosed())return;
        if(error.statusCode===404||error.statusCode===410)db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(job.endpoint);
        else db.prepare('UPDATE booking_reminders SET attempts=?,next_attempt=? WHERE id=?').run(job.attempts+1,Math.min(startAt,now().getTime()+Math.min(3600000,15000*2**Math.min(job.attempts+1,8))),job.id);
      }
    }
  }
  return {syncDay,restore,flush,clearEndpoint:endpoint=>{const result=db.prepare('DELETE FROM booking_reminders WHERE endpoint=?').run(endpoint);if(result.changes)onQueued();return result;}};
}
