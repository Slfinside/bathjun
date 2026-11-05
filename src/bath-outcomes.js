import {readFileSync} from 'node:fs';
import {slotDate} from './domain.js';
export function migrateBathOutcomes(db){
 if(db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get('0024_bath_outcomes'))return;
 db.exec('SAVEPOINT bath_outcomes_migration');
 try{db.exec(readFileSync(new URL('../migrations/0024_bath_outcomes.sql',import.meta.url),'utf8'));db.prepare('INSERT INTO schema_migrations VALUES(?)').run('0024_bath_outcomes');db.exec('RELEASE bath_outcomes_migration')}
 catch(error){db.exec('ROLLBACK TO bath_outcomes_migration; RELEASE bath_outcomes_migration');throw error}
}
export function bookingHistory(db,day){
 return db.prepare('SELECT h.*,n.reported_at FROM rebooking_history h JOIN bath_noncompletions n ON n.revision=h.old_revision WHERE h.day=? ORDER BY h.created_at,h.old_revision').all(day).map(row=>{
  const b=JSON.parse(row.old_booking_json);return {memberId:b.member_id,start:b.start,duration:b.duration,note:b.note,noNegotiation:!!b.no_negotiation,revision:b.revision,ticket:b.ticket,automatic:b.automatic,completedAt:null,notBathedAt:row.reported_at,archived:true};
 });
}
export function pendingBathReports(db,now,member=null){
 return db.prepare(`SELECT b.day,b.member_id AS memberId,b.start,b.duration,b.revision,m.name FROM bookings b JOIN members m ON m.id=b.member_id WHERE m.active=1 AND (? IS NULL OR b.member_id=?) AND NOT EXISTS(SELECT 1 FROM bath_completions c WHERE c.revision=b.revision) AND NOT EXISTS(SELECT 1 FROM bath_noncompletions n WHERE n.revision=b.revision) ORDER BY b.day DESC,b.start DESC`).all(member,member).filter(b=>slotDate(b.day,b.start)<=now).slice(0,200);
}
