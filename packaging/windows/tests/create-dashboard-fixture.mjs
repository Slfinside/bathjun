import {writeFileSync} from 'node:fs';
import {dashboardView,dashboardQr} from '../../../src/dashboard.js';
import {DEFAULT_SCHEDULE} from '../../../src/server-settings.js';
const snapshot={day:'2026-10-29',now:'2026-10-29T18:10:00+09:00',settings:DEFAULT_SCHEDULE,
 members:Array.from({length:5},(_,i)=>({id:i+1,name:'メンバー'+String.fromCharCode(65+i),active:true,emoji:['🐶','🐱','🌷',null,'🌙'][i],color:['#77a66b','#579ac7','#d67f79',null,'#9c7bc6'][i]})),
 bookings:[{memberId:1,start:1080,duration:30,automatic:1},{memberId:2,start:1140,duration:45},{memberId:5,start:1260,duration:30}].map(b=>({...b,revision:String(b.memberId).padStart(32,'0')})),wishes:[{memberId:3,start:1155,duration:60,automatic:1},{memberId:4,start:1185,duration:30}],skips:[4]};
writeFileSync(process.argv[2],JSON.stringify({...dashboardView(snapshot),phase:'ready',...dashboardQr({phase:'ready',url:'https://example.test:8443/family/'+'a'.repeat(64)+'/'})}));
