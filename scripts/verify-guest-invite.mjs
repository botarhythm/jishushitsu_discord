// 招待リンク・ゲストセッション・回 (space) の検証 (T-20261010-02 H1〜H4 / Q1=案a)。
//
//   node --test scripts/verify-guest-invite.mjs            # LiveKit を使わない検証
//   VERIFY_LIVE=1 node --test scripts/verify-guest-invite.mjs  # 失効 (LiveKit room metadata) も検証
//
// next dev を専用ポートで起動して HTTP で叩く。SESSION_SECRET はこの実行だけの乱数で上書きし
// (.env.local の値は読まない)、講師セッションと期限を操作した招待トークンをここで署名する。
// LiveKit の設定は .env.local のものを next がそのまま使う (このスクリプトは値を読まない)。
// VERIFY_LIVE=1 のときだけ LiveKit に `verify-*` の回の部屋を作る (空き部屋は LiveKit が自動で閉じる)。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SignJWT, decodeJwt } from 'jose';

const PORT = Number(process.env.VERIFY_PORT || 3107);
const BASE = `http://localhost:${PORT}`;
const LIVE = process.env.VERIFY_LIVE === '1';
const SECRET = randomBytes(32).toString('hex');
const key = new TextEncoder().encode(SECRET);
const SPACE = `verify-${randomBytes(3).toString('hex')}`;

let server;

before(async () => {
  server = spawn('npx', ['next', 'dev', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, SESSION_SECRET: SECRET },
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/space`);
      if (res.status === 401) return; // 起動完了 (未認証なので 401)
    } catch {}
    await sleep(1000);
  }
  throw new Error('next dev が起動しませんでした');
});

after(() => {
  if (!server) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else server.kill('SIGTERM');
});

async function sessionCookie(payload, ttlSec = 3600) {
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec)
    .sign(key);
  return `lk_session=${jwt}`;
}

async function inviteToken({ expSec, space }) {
  return new SignJWT({ roomName: 'main', role: 'student', initialRec: 'off', ...(space ? { space } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSec)
    .sign(key);
}

async function post(path, body, cookie, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const setCookie = res.headers.get('set-cookie');
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, setCookie };
}

function cookieFrom(setCookie) {
  const m = /lk_session=([^;]+)/.exec(setCookie ?? '');
  assert.ok(m, 'session Cookie が返らない');
  const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1]);
  return { cookie: `lk_session=${m[1]}`, jwt: m[1], maxAge };
}

async function joinAsGuest(token, displayName = 'verify guest') {
  return post('/api/auth/guest', { token, displayName });
}

const instructor = () =>
  sessionCookie({ discordId: 'verify-instructor', displayName: 'verify', role: 'instructor', kind: 'discord' });

test('Q1: X-Service-Secret だけでは招待リンクを発行できない (401)', async () => {
  const r = await post('/api/invite-token', { role: 'instructor' }, null, { 'x-service-secret': 'anything' });
  assert.equal(r.status, 401);
});

test('H2: 期限を選んで発行できる。範囲外は 400', async () => {
  const cookie = await instructor();
  const now = Math.floor(Date.now() / 1000);
  const r = await post('/api/invite-token', { ttlHours: 72 }, cookie);
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.json.expiresAt - (now + 72 * 3600)) < 30, `expiresAt=${r.json.expiresAt}`);
  const d = await post('/api/invite-token', {}, cookie);
  assert.ok(Math.abs(d.json.expiresAt - (now + 24 * 3600)) < 30, '既定は 24h');
  assert.equal((await post('/api/invite-token', { ttlHours: 5 }, cookie)).status, 400);
  assert.equal((await post('/api/invite-token', { ttlHours: 999 }, cookie)).status, 400);
});

test('H1: ゲストのセッション期限はリンクの期限にそろう (1h を超えて有効)', async () => {
  const cookie = await instructor();
  const issued = await post('/api/invite-token', { ttlHours: 6 }, cookie);
  const token = new URL(issued.json.url).pathname.split('/').pop();
  const join = await joinAsGuest(token);
  assert.equal(join.status, 200);
  const s = cookieFrom(join.setCookie);
  assert.equal(decodeJwt(s.jwt).exp, issued.json.expiresAt, 'セッション JWT の exp = リンクの期限');
  assert.ok(s.maxAge > 5 * 3600 && s.maxAge <= 6 * 3600, `Cookie Max-Age=${s.maxAge}`);
  const t = await post('/api/token', { roomName: 'main' }, s.cookie);
  assert.equal(t.status, 200);
});

test('H1: リンクの期限を過ぎると /api/token も再入室も 401 (実時間で 6 秒待つ)', async () => {
  const token = await inviteToken({ expSec: 4 });
  const join = await joinAsGuest(token);
  assert.equal(join.status, 200);
  const s = cookieFrom(join.setCookie);
  assert.equal((await post('/api/token', { roomName: 'main' }, s.cookie)).status, 200);
  await sleep(6000);
  assert.equal((await post('/api/token', { roomName: 'main' }, s.cookie)).status, 401);
  assert.equal((await joinAsGuest(token)).status, 401);
});

test('H3: 同じリンクで再入室できる (410 にならない)。参加者 ID は同じ', async () => {
  const token = await inviteToken({ expSec: 3600 });
  const a = await joinAsGuest(token, 'first');
  const b = await joinAsGuest(token, 'second');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const idA = decodeJwt((await post('/api/token', { roomName: 'main' }, cookieFrom(a.setCookie).cookie)).json.token).sub;
  const idB = decodeJwt((await post('/api/token', { roomName: 'main' }, cookieFrom(b.setCookie).cookie)).json.token).sub;
  assert.equal(idA, idB);
  assert.match(idA, /^guest:/);
});

test('H4: 回の違うリンクで入った 2 人は別の LiveKit の部屋に入る', async () => {
  const defaultGuest = cookieFrom((await joinAsGuest(await inviteToken({ expSec: 3600 }))).setCookie).cookie;

  // 講師が回を切り替えてから発行する
  const sw = await post('/api/space', { space: SPACE }, await instructor());
  assert.equal(sw.status, 200);
  const spacedInstructor = cookieFrom(sw.setCookie).cookie;
  const issued = await post('/api/invite-token', { ttlHours: 2 }, spacedInstructor);
  assert.equal(issued.json.space, SPACE);
  const spaceGuest = cookieFrom((await joinAsGuest(new URL(issued.json.url).pathname.split('/').pop())).setCookie).cookie;

  const roomOf = async (c, roomName) => {
    const r = await post('/api/token', { roomName }, c);
    assert.equal(r.status, 200, `${roomName}: ${JSON.stringify(r.json)}`);
    return decodeJwt(r.json.token).video.room;
  };
  assert.equal(await roomOf(defaultGuest, 'main'), 'main');
  assert.equal(await roomOf(spaceGuest, 'main'), `${SPACE}--main`);
  assert.equal(await roomOf(spaceGuest, 'bo-1'), `${SPACE}--bo-1`);
  assert.equal(await roomOf(spacedInstructor, 'main'), `${SPACE}--main`);
});

test('H4: 回ID の形式チェック・ゲストは回を変えられない・部屋名は論理名だけ', async () => {
  const cookie = await instructor();
  assert.equal((await post('/api/space', { space: 'Bad Space!' }, cookie)).status, 400);
  assert.equal((await post('/api/space', { space: 'a--b' }, cookie)).status, 400);
  const guest = cookieFrom((await joinAsGuest(await inviteToken({ expSec: 3600 }))).setCookie).cookie;
  assert.equal((await post('/api/space', { space: 'other' }, guest)).status, 403);
  assert.equal((await post('/api/token', { roomName: 'other--main' }, guest)).status, 400);
});

test('H3: 失効させたリンクは再入室もトークン取得も 410 (LiveKit 使用)', { skip: !LIVE && 'VERIFY_LIVE=1 のときだけ' }, async () => {
  const sw = await post('/api/space', { space: SPACE }, await instructor());
  const spacedInstructor = cookieFrom(sw.setCookie).cookie;
  const issued = await post('/api/invite-token', { ttlHours: 2 }, spacedInstructor);
  const token = new URL(issued.json.url).pathname.split('/').pop();
  const guest = cookieFrom((await joinAsGuest(token)).setCookie).cookie;
  const identity = decodeJwt((await post('/api/token', { roomName: 'main' }, guest)).json.token).sub;

  const other = cookieFrom((await joinAsGuest(await inviteToken({ expSec: 3600, space: SPACE }))).setCookie).cookie;

  const rm = await post(
    '/api/remove-participant',
    { roomName: 'main', participantIdentity: identity, revokeInvite: true },
    spacedInstructor
  );
  assert.equal(rm.status, 200, JSON.stringify(rm.json));
  assert.equal(rm.json.revoked, true);

  assert.equal((await joinAsGuest(token)).status, 410);
  assert.equal((await post('/api/token', { roomName: 'main' }, guest)).status, 410);
  // 同じ回の別のリンクは影響を受けない
  assert.equal((await post('/api/token', { roomName: 'main' }, other)).status, 200);
  // Discord 参加者は失効の対象にできない
  const bad = await post(
    '/api/remove-participant',
    { roomName: 'main', participantIdentity: 'discord:123', revokeInvite: true },
    spacedInstructor
  );
  assert.equal(bad.status, 400);
});
