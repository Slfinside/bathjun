import {writeFileSync} from 'node:fs';
import {dashboardView,dashboardQr} from '../../../src/dashboard.js';
import {DEFAULT_SCHEDULE} from '../../../src/server-settings.js';
const snapshot={day:'2026-10-29',now:'2026-10-29T18:10:00+09:00',settings:DEFAULT_SCHEDULE,
 members:Array.from({length:5},(_,i)=>({id:i+1,name:'メンバー'+String.fromCharCode(65+i),active:true,emoji:['🐶','🐱','🌷',null,'🌙'][i],color:['#77a66b','#579ac7','#d67f79',null,'#9c7bc6'][i]})),
 bookings:[{memberId:1,start:1080,duration:30},{memberId:2,start:1140,duration:45},{memberId:5,start:1260,duration:30}],wishes:[{memberId:3,start:1200,duration:30}],skips:[4]};
writeFileSync(process.argv[2],JSON.stringify({...dashboardView(snapshot),phase:'ready',...dashboardQr({phase:'ready',url:'https://example.test:8443/family/'+'a'.repeat(64)+'/'})}));
