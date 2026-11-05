// Keep this entry point independent of the app so even import failures are visible.
import {readFileSync} from 'node:fs';
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
console.log(`ふろじゅん v${version}`);
try { await import('./windows-server.js'); }
catch(error){ console.error('ふろじゅんを起動できませんでした。'); console.error(error.stack||error.message); process.exitCode=1; }
