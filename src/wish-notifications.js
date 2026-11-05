import {randomBytes} from 'node:crypto';
import {getNotificationPreferences} from './notification-preferences.js';
import {slotDate} from './domain.js';
export function createWishNotifications({db,now,deliverPush,familyConfig,onQueued,isClosed,currentTurn}) {
  function record(wish,kind) {
    const id=wish.revision+'-'+kind;let queued=false;
    db.exec('SAVEPOINT wish_notification_record');
    try {
      const result=db.prepare('INSERT OR IGNORE INTO wish_outcomes VALUES(?,?,?,?,?,?,?)').run(id,wish.revision,wish.day,wish.member_id,kind,wish.start,wish.duration);
      if(result.changes&&getNotificationPreferences(db,wish.member_id)[kind]) {
        const subs=db.prepare('SELECT p.endpoint FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash WHERE p.member_id=? AND s.expires>?').all(wish.member_id,now().getTime());
        for(const sub of subs)db.prepare('INSERT INTO wish_notification_jobs(id,event_id,endpoint,next_attempt) VALUES(?,?,?,?)').run(randomBytes(16).toString('hex'),id,sub.endpoint,now().getTime());
        queued=!!subs.length;
      }
      db.exec('RELEASE wish_notification_record');
    }catch(error){db.exec('ROLLBACK TO wish_notification_record; RELEASE wish_notification_record');throw error;}
    if(queued)onQueued();
  }
  async function flush() {
    const jobs=db.prepare('SELECT j.*,e.revision,e.day,e.member_id,e.kind,e.start,e.duration,p.subscription_json,p.member_id AS owner,s.expires,m.name,m.active FROM wish_notification_jobs j JOIN wish_outcomes e ON e.id=j.event_id JOIN push_subscriptions p ON p.endpoint=j.endpoint JOIN sessions s ON s.token_hash=p.session_hash JOIN members m ON m.id=e.member_id WHERE j.sent=0 AND j.next_attempt<=? ORDER BY j.next_attempt LIMIT 20').all(now().getTime());
    for(const job of jobs) {
      const valid=job.kind==='wishConfirmed'
        ? db.prepare('SELECT 1 FROM bookings WHERE day=? AND member_id=? AND auto_revision=?').get(job.day,job.member_id,job.revision)
        : currentTurn(job.day)===job.member_id&&db.prepare('SELECT 1 FROM wishes WHERE day=? AND member_id=? AND revision=?').get(job.day,job.member_id,job.revision);
      if(!valid||!job.active||job.owner!==job.member_id||job.expires<=now().getTime()||!getNotificationPreferences(db,job.member_id)[job.kind]||(job.kind==='wishConfirmed'&&slotDate(job.day,job.start+job.duration)<=now())) {
        db.prepare('DELETE FROM wish_notification_jobs WHERE id=?').run(job.id);continue;
      }
      const time=(job.start>=1440?'翌':'')+String(Math.floor(job.start/60)%24).padStart(2,'0')+':'+String(job.start%60).padStart(2,'0');
      const config=familyConfig(),confirmed=job.kind==='wishConfirmed';
      try {
        await deliverPush(JSON.parse(job.subscription_json),{
          title:confirmed?'事前希望が確定しました ♨':'事前希望を確定できませんでした',
          body:confirmed?`${job.day}の夜：${job.name}さんの${time}からの希望を予約として確定しました。`:`${job.day}の夜：${job.name}さんの希望は、ほかの予約・希望との重なりや時刻の条件により確定できませんでした。時間を確認してください。`,
          tag:`bath-wish-${job.kind}-${job.day}-${job.member_id}`,day:job.day,url:'/'
        },{publicKey:config.vapid_public,privateKey:config.vapid_private});
        if(isClosed())return;
        db.prepare('UPDATE wish_notification_jobs SET sent=1 WHERE id=?').run(job.id);
      }catch(error) {
        if(isClosed())return;
        if(error.statusCode===404||error.statusCode===410)db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(job.endpoint);
        else db.prepare('UPDATE wish_notification_jobs SET attempts=?,next_attempt=? WHERE id=?').run(job.attempts+1,now().getTime()+Math.min(3600000,15000*2**Math.min(job.attempts+1,8)),job.id);
      }
    }
  }
  return {record,flush};
}
