import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {slotDate} from './domain.js';
import {bathCalendar} from './bath-calendar.js';
import {getNotificationPreferences} from './notification-preferences.js';
const MINUTE=60000;
const hash=endpoint=>createHash('sha256').update(endpoint).digest('hex');

// Demand is continuous between booking starts/ends. No polling timer is needed.
export function planningDemand(plan,instant) {
  let minutes=plan.wishMinutes;
  for(const booking of plan.bookings)
    minutes+=Math.max(0,Math.min(booking.duration,(booking.end-instant)/MINUTE));
  return {minutes,requiredMinutes:minutes*1.2+60,remainingMinutes:(plan.deadline-instant)/MINUTE};
}
export function nextPlanningTime(plan,instant) {
  if(!plan.hasUntimed || instant>=plan.expiresAt)return null;
  if(plan.allReady)return instant;
  const events=[instant,...plan.bookings.flatMap(b=>[b.start,b.end]).filter(t=>t>instant&&t<plan.expiresAt),plan.expiresAt].sort((a,b)=>a-b);
  for(let i=0;i<events.length-1;i++){
    const from=events[i],to=events[i+1],demand=planningDemand(plan,from);
    const difference=demand.requiredMinutes-demand.remainingMinutes;
    if(difference>0)return from;
    const bathing=plan.bookings.filter(b=>b.start<=from&&from<b.end).length;
    const slope=1-1.2*bathing;
    if(slope>0){
      // Strictly greater, rather than equal: choose the first millisecond after crossing.
      const crossing=from+Math.floor(-difference/slope*MINUTE)+1;
      if(crossing<to)return crossing;
    }
  }
  return null;
}

export function createTimeSelectionNotifications({db,now,scheduleForDay,nightDeadline,deliverPush,familyConfig,isClosed}) {
  db.exec(readFileSync(new URL('../migrations/0022_time_selection_notifications.sql',import.meta.url),'utf8'));
  const receipt=job=>!!db.prepare('SELECT 1 FROM time_selection_receipts WHERE endpoint_hash=? AND day=? AND member_id=?').get(hash(job.endpoint),job.day,job.member_id);
  function planFor(day){
    const deadline=slotDate(day,1440+nightDeadline()).getTime();
    const members=db.prepare('SELECT id FROM members WHERE active=1').all().map(m=>m.id);
    const bookings=db.prepare('SELECT b.* FROM bookings b JOIN members m ON m.id=b.member_id WHERE b.day=? AND m.active=1').all(day);
    const wishes=db.prepare('SELECT w.* FROM wishes w JOIN members m ON m.id=w.member_id WHERE w.day=? AND m.active=1').all(day);
    const skips=db.prepare('SELECT member_id FROM bath_skips WHERE day=?').all(day).map(s=>s.member_id);
    const answered=new Set([...bookings,...wishes].map(x=>x.member_id).concat(skips));
    const untimed=wishes.filter(w=>w.start===null&&!bookings.some(b=>b.member_id===w.member_id));
    const nighttime=bookings.filter(b=>!db.prepare('SELECT 1 FROM bath_noncompletions WHERE revision=?').get(b.revision)&&slotDate(day,b.start).getTime()<deadline&&!db.prepare('SELECT 1 FROM bath_completions WHERE revision=?').get(b.revision));
    return {day,deadline,expiresAt:Math.min(deadline,slotDate(day,scheduleForDay(day).bathEnd).getTime()),
      hasUntimed:untimed.length>0,untimed,allReady:members.length>0&&members.every(id=>answered.has(id)),
      wishMinutes:wishes.filter(w=>(w.start===null||slotDate(day,w.start).getTime()<deadline)&&!bookings.some(b=>b.member_id===w.member_id)).reduce((sum,w)=>sum+w.duration,0),
      bookings:nighttime.map(b=>({start:slotDate(day,b.start).getTime(),end:slotDate(day,b.start+b.duration).getTime(),duration:b.duration}))};
  }
  function status(day){
    const plan=planFor(day),instant=now().getTime(),demand=planningDemand(plan,instant);
    const eligible=plan.hasUntimed&&instant<plan.expiresAt;
    const reason=eligible?(plan.allReady?'all-ready':demand.requiredMinutes>demand.remainingMinutes?'capacity':null):null;
    return {day,nightDeadline:nightDeadline(),deadline:new Date(plan.deadline).toISOString(),allReady:plan.allReady,...demand,reason};
  }
  function targets(day){
    return db.prepare('SELECT p.endpoint,p.member_id FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash JOIN members m ON m.id=p.member_id JOIN wishes w ON w.member_id=p.member_id WHERE w.day=? AND w.start IS NULL AND m.active=1 AND s.member_id=p.member_id AND s.expires>? AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.day=w.day AND b.member_id=w.member_id)').all(day,now().getTime()).filter(sub=>getNotificationPreferences(db,sub.member_id).timeSelectionReminder&&!receipt({...sub,day}));
  }
  function days(){const calendar=bathCalendar(now());return db.prepare('SELECT DISTINCT w.day FROM wishes w JOIN members m ON m.id=w.member_id WHERE w.start IS NULL AND m.active=1 AND w.day>=? AND w.day<=?').all(calendar.yesterday,calendar.dayAfterTomorrow).map(x=>x.day)}
  function sync(){
    for(const job of db.prepare('SELECT * FROM time_selection_jobs').all())
      if(!status(job.day).reason||!targets(job.day).some(t=>t.endpoint===job.endpoint&&t.member_id===job.member_id))db.prepare('DELETE FROM time_selection_jobs WHERE id=?').run(job.id);
    for(const day of days()){
      if(!status(day).reason)continue;
      for(const sub of targets(day))db.prepare('INSERT OR IGNORE INTO time_selection_jobs(id,endpoint,day,member_id,next_attempt) VALUES(?,?,?,?,?)').run(randomBytes(16).toString('hex'),sub.endpoint,day,sub.member_id,now().getTime());
    }
  }
  function dueAt(){
    let due=null;
    for(const day of days()){
      if(!targets(day).some(sub=>!db.prepare('SELECT 1 FROM time_selection_jobs WHERE endpoint=? AND day=? AND member_id=?').get(sub.endpoint,day,sub.member_id)))continue;
      const candidate=nextPlanningTime(planFor(day),now().getTime());
      if(candidate!==null)due=due===null?candidate:Math.min(due,candidate);
    }
    return due;
  }
  async function flush(){
    if(isClosed())return;
    sync();
    for(const queued of db.prepare('SELECT id FROM time_selection_jobs WHERE next_attempt<=? ORDER BY next_attempt,id LIMIT 20').all(now().getTime())){
      if(isClosed())return;
      const job=db.prepare('SELECT j.*,p.subscription_json,p.member_id AS owner,s.member_id AS session_member,s.expires FROM time_selection_jobs j JOIN push_subscriptions p ON p.endpoint=j.endpoint JOIN sessions s ON s.token_hash=p.session_hash WHERE j.id=? AND j.next_attempt<=?').get(queued.id,now().getTime());
      if(!job)continue;
      const state=status(job.day),plan=planFor(job.day);
      if(!state.reason||job.owner!==job.member_id||job.session_member!==job.member_id||job.expires<=now().getTime()||!getNotificationPreferences(db,job.member_id).timeSelectionReminder||!plan.untimed.some(w=>w.member_id===job.member_id)||receipt(job)){
        db.prepare('DELETE FROM time_selection_jobs WHERE id=?').run(job.id);continue;
      }
      const keys=familyConfig();
      try{
        await deliverPush(JSON.parse(job.subscription_json),{
          title:'おふろの開始時刻を決めましょう',
          body:`${job.day}分のおふろ：${state.reason==='all-ready'?'みんなの予定がそろいました。':'夜の残り時間が少なくなってきました。'}使う時間だけの希望に、開始時刻を追加してください。`,
          tag:`bath-time-selection-${job.day}-${job.member_id}`,day:job.day,url:'/'
        },{publicKey:keys.vapid_public,privateKey:keys.vapid_private},{ttl:Math.max(1,Math.floor((plan.expiresAt-now().getTime())/1000))});
        if(isClosed())return;
        db.exec('SAVEPOINT delivered_time_selection');
        try{
          db.prepare('INSERT OR IGNORE INTO time_selection_receipts VALUES(?,?,?,?)').run(hash(job.endpoint),job.day,job.member_id,now().toISOString());
          db.prepare('DELETE FROM time_selection_jobs WHERE endpoint=? AND day=? AND member_id=?').run(job.endpoint,job.day,job.member_id);
          db.exec('RELEASE delivered_time_selection');
        }catch(error){db.exec('ROLLBACK TO delivered_time_selection; RELEASE delivered_time_selection');throw error}
      }catch(error){
        if(isClosed())return;
        if(error.statusCode===404||error.statusCode===410)db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(job.endpoint);
        else db.prepare('UPDATE time_selection_jobs SET attempts=attempts+1,next_attempt=? WHERE id=?').run(Math.min(plan.expiresAt+1,now().getTime()+Math.min(60000,15000*2**Math.min(job.attempts,3))),job.id);
      }
    }
  }
  return {sync,dueAt,flush,status,clearEndpoint:endpoint=>db.prepare('DELETE FROM time_selection_jobs WHERE endpoint=?').run(endpoint)};
}
