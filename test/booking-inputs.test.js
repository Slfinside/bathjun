import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bookingMinute,clockInput} from '../public/booking-inputs.js';
import {createApp} from '../src/app.js';
import {DEFAULT_SCHEDULE,validateSchedule} from '../src/server-settings.js';

test('native clock values map to the correct booking day across both midnights',()=>{
  assert.equal(bookingMinute('18:05',420),1085);
  assert.equal(bookingMinute('00:05',420),1445);
  assert.equal(bookingMinute('06:55',420),1855);
  assert.equal(bookingMinute('07:00',420),420);
  assert.equal(bookingMinute('22:55',1380),2815);
  assert.equal(bookingMinute('23:00',1380),1380);
  for(const value of ['', '24:00', '12:60', '6:00', '18:05:30'])assert.equal(bookingMinute(value,420),null);
  for(const minutes of [420,1085,1445,1855,2815])assert.equal(bookingMinute(clockInput(minutes),minutes===2815?1380:420),minutes);
});

test('new households default to five minutes and saved fifteen-minute rules survive restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'bathjun-five-minute-'));
  let app,clock=new Date('2026-11-17T08:00:00+09:00');
  const open=()=>createApp({database:join(directory,'test.sqlite'),now:()=>clock,requireFamily:false,deliverPush:async()=>{}});
  try {
    app=open();assert.equal(DEFAULT_SCHEDULE.step,5);assert.equal(app.getServerSettings().current.step,5);
    assert.equal(validateSchedule({...DEFAULT_SCHEDULE,minDuration:15,maxDuration:90}).step,5);
    app.saveServerSettings({members:[],schedule:{...DEFAULT_SCHEDULE,step:15}});
    clock=new Date('2026-11-18T08:00:00+09:00');
    assert.equal(app.getServerSettings().current.step,15);
    app.close();app=open();assert.equal(app.getServerSettings().current.step,15);
    assert.equal(app.getServerSettings().upcoming.step,15);
  } finally {app?.close();rmSync(directory,{recursive:true,force:true});}
});
