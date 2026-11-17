import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpTransport } from '../public/transport.js';

test('通信層はGETを保存せず、POSTを自動再送せず、同一接続先だけに送信する', async () => {
  const calls = [];
  const { request } = createHttpTransport({ fetchImpl: async (...args) => { calls.push(args); return Response.json({ ok: true }); } });
  await request('state?day=2026-11-04');
  await request('book', { start: 1080 });
  assert.equal(calls[0][0], '/api/state?day=2026-11-04');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[1][1].method, 'POST');
  assert.equal(calls[1][1].credentials, 'same-origin');
  assert.deepEqual(JSON.parse(calls[1][1].body), { start: 1080 });
  for (const path of ['https://example.com', '//example.com', '../state', 'state#x']) await assert.rejects(request(path));
  assert.equal(calls.length, 2);
});

test('旧APIの404だけを互換接続にし、認証失敗・未知のAPI版・通信障害を隠さない', async () => {
  const discover = response => createHttpTransport({ fetchImpl: async () => response }).discover();
  assert.equal((await discover(Response.json({ error: 'missing' }, { status: 404 }))).mode, 'legacy-windows');
  await assert.rejects(discover(Response.json({ error: 'login' }, { status: 401 })), { status: 401 });
  await assert.rejects(discover(Response.json({ product: 'bathjun', apiVersion: 2 })), /API/);
  const connection = { product: 'bathjun', apiVersion: 1, householdId: 'cf4e337a-e19b-4c34-a153-30303975c3d2', capabilities: ['household-id'] };
  assert.deepEqual(await discover(Response.json(connection)), connection);
  await assert.rejects(discover(Response.json({ ...connection, householdId: '' })), /API/);
  await assert.rejects(discover(Response.json({ ...connection, capabilities: [42] })), /API/);
  await assert.rejects(createHttpTransport({ fetchImpl: async () => { throw new Error('offline'); } }).discover(), /接続できません/);
});

test('JSON以外のゲートウェイ応答・タイムアウト・確定エラーを区別する', async () => {
  await assert.rejects(createHttpTransport({ fetchImpl: async () => new Response('<html>', { status: 502 }) }).request('state'), { status: 502 });
  let calls = 0;
  await assert.rejects(createHttpTransport({ fetchImpl: async () => { calls++; return Response.json({ error: '予約が変更されています' }, { status: 409 }); } }).request('book', {}), { status: 409, message: '予約が変更されています' });
  assert.equal(calls, 1);
  const slow = createHttpTransport({ timeoutMs: 5, fetchImpl: (_path, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(slow.request('state'), /時間がかかっています/);
});
