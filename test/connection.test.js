import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { DEFAULT_SCHEDULE } from '../src/server-settings.js';

async function serve(app, fn) {
  const server = createServer(app.handle);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/api/`); }
  finally { await new Promise(r => server.close(r)); app.close(); }
}

test('家庭IDは旧DBへ追加され、既存データ・再起動・DB移設・パスワード変更で維持する', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bathjun-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'old.sqlite');
  let clock = new Date('2026-11-02T08:00:00+09:00');
  const options = { database, requireFamily: false, now: () => clock, deliverPush: async () => {} };
  const app = createApp(options);
  app.saveServerSettings({ members: [{ name: 'synthetic-A', active: true }, { name: 'synthetic-B', active: true }], schedule: { ...DEFAULT_SCHEDULE, orderMode: 'fixed' } });
  clock = new Date('2026-11-04T08:00:00+09:00');
  await app.changePassword({ target: 'family', password: 'synthetic-family' });
  app.distributeItems({ recipients: [1], kinds: ['guard'], quantity: 2, requestId: 'identity-gift' });
  await serve(app, async base => {
    let cookie = '';
    for (const [path, body] of [['register', { memberId: 1, password: 'synthetic-member' }], ['book', { day: '2026-11-04', start: 1080, duration: 30 }]]) {
      const response = await fetch(base + path, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.text());
      cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') || cookie;
    }
  });
  // Previous versions have this exact family table without household_id.
  const old = new DatabaseSync(database);
  old.exec('ALTER TABLE family_config DROP COLUMN household_id');
  const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name);
  const before = tables.map(name => old.prepare(`SELECT * FROM "${name}"`).all());
  old.close();
  const id = await serve(createApp(options), async base => {
    const response = await fetch(base + 'connection');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.match(result.householdId, /^[0-9a-f-]{36}$/);
    assert.equal(result.apiVersion, 1);
    assert.ok(!result.capabilities.includes('migration'));
    return result.householdId;
  });
  const after = new DatabaseSync(database);
  for (const [i, name] of tables.entries()) {
    const rows = after.prepare(`SELECT * FROM "${name}"`).all();
    if (name === 'family_config') for (const row of rows) delete row.household_id;
    assert.deepEqual(rows, before[i], name);
  }
  after.close();
  const moved = join(directory, 'moved.sqlite');
  copyFileSync(database, moved);
  const reopened = createApp({ ...options, database: moved });
  await reopened.changePassword({ target: 'family', password: 'synthetic-changed' });
  await serve(reopened, async base => {
    assert.equal((await (await fetch(base + 'connection')).json()).householdId, id);
    reopened.resetAllData({ confirmation: 'RESET_ALL_DATA' });
    assert.notEqual((await (await fetch(base + 'connection')).json()).householdId, id);
  });
});

test('家庭の認証前にはIDを開示せず、メンバーAPIと同じ家族認証を使う', async () => {
  const app = createApp();
  await app.changePassword({ target: 'family', password: 'synthetic-family' });
  await serve(app, async base => {
    const denied = await fetch(base + 'connection');
    assert.equal(denied.status, 401);
    assert.equal((await denied.json()).householdId, undefined);
    const login = await fetch(base + 'family/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-family' }) });
    const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    assert.equal((await fetch(base + 'connection', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + 'state', { headers: { cookie } })).status, 401);
    assert.equal((await fetch(base + 'connection', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  });
});
