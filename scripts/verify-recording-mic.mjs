// 収録モードの録画中に入室した受講生のマイクが OFF で始まること、録画中でなければ ON で
// 始まること、講師のマイク OFF 指示 (/api/set-participant-mic) が届くことを実際の LiveKit で確かめる。
//
//   node scripts/verify-recording-mic.mjs
//
// next dev を専用ポートで起動し、SESSION_SECRET はこの実行だけの乱数で上書きする
// (.env.local の値は読まない)。LiveKit の設定は .env.local のものを next がそのまま使う。
// LiveKit に `verify-*` の回の部屋を作る (空き部屋は LiveKit が自動で閉じる)。
// 講師はブラウザで入室せず、API だけを叩く (broadcast-studio は送信者の在室を確かめないため)。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SignJWT } from 'jose';
import { chromium } from 'playwright';

const PORT = Number(process.env.VERIFY_PORT || 3108);
const BASE = `http://localhost:${PORT}`;
const SECRET = randomBytes(32).toString('hex');
const key = new TextEncoder().encode(SECRET);
const SPACE = `verify-${randomBytes(3).toString('hex')}`;

async function sessionJwt(payload) {
  return new SignJWT({ kind: 'discord', space: SPACE, ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(key);
}

async function post(path, body, jwt) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: `lk_session=${jwt}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let revision = Date.now();
async function broadcast(instructorJwt, { active, recording }) {
  revision += 1;
  const r = await post(
    '/api/broadcast-studio',
    {
      roomName: 'main',
      active,
      layout: 'split',
      slots: [null, null],
      showNameplates: true,
      showAudience: false,
      recording,
      schemaVersion: 2,
      revision,
      ai: null,
    },
    instructorJwt
  );
  assert.equal(r.status, 200, `broadcast-studio: ${JSON.stringify(r.json)}`);
}

// Playwright 同梱のブラウザが無い環境でも動くよう、インストール済みの Chrome を使う
const browser = await chromium.launch({
  channel: process.env.VERIFY_BROWSER_CHANNEL || 'chrome',
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const server = spawn('npx', ['next', 'dev', '--port', String(PORT)], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, SESSION_SECRET: SECRET },
  shell: process.platform === 'win32',
  stdio: 'ignore',
});
const stopServer = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else server.kill('SIGTERM');
};

/** 受講生として入室し、マイク ON/OFF ボタンの表示から実際の publish 状態を読む */
const joinAsStudent = (name) => joinAs(name, 'student');

async function joinAs(name, role) {
  const context = await browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: 'lk_session', value: await sessionJwt({ discordId: `verify-${name}`, displayName: name, role }), url: BASE },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/room`);
  await page.getByRole('button', { name: '参加する', exact: true }).click({ timeout: 120_000 });
  return { context, page, errors };
}

/** ControlBar のボタン名は「🎤 マイクOFF」のように「押すと何になるか」。ON なら「マイクOFF」と出る */
async function micState(page) {
  const on = page.getByRole('button', { name: /マイクOFF$/ });
  const off = page.getByRole('button', { name: /マイクON$/ });
  await on.or(off).first().waitFor({ timeout: 30_000 });
  return (await on.count()) > 0 ? 'on' : 'off';
}

async function waitMic(page, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await micState(page);
    if (state === expected) return state;
    await sleep(500);
  }
  return state;
}

try {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/space`);
      if (res.status === 401) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('next dev が起動しませんでした');
    await sleep(1000);
  }

  const instructorJwt = await sessionJwt({ discordId: 'verify-instructor', displayName: '講師', role: 'instructor' });

  // 1) 録画していないとき: 入室前の選択 (既定 ON) のとおりマイクが入る
  const a = await joinAsStudent('student-a');
  assert.equal(await waitMic(a.page, 'on'), 'on', '録画していないときはマイク ON で入室する');
  console.log('PASS 1: 録画していないときはマイク ON で入室');

  // 2) 講師のマイク OFF 指示が届く
  const identityA = 'discord:verify-student-a'; // livekitIdentityFor() の形
  const off = await post('/api/set-participant-mic', { participantIdentity: identityA, roomName: 'main', enabled: false }, instructorJwt);
  assert.equal(off.status, 200, JSON.stringify(off.json));
  assert.equal(await waitMic(a.page, 'off'), 'off', '講師の OFF 指示でマイクが OFF になる');
  console.log('PASS 2: 講師の OFF 指示で受講生のマイクが OFF になる');

  // 3) 収録モードで録画中: 後から入室した受講生はマイク OFF、お知らせが出る
  await broadcast(instructorJwt, { active: true, recording: true });
  const b = await joinAsStudent('student-b');
  await sleep(3000); // 接続後のマイク判定が走りきるのを待つ
  assert.equal(await micState(b.page), 'off', '録画中に入室した受講生はマイク OFF');
  await b.page.getByText('収録中のため、マイクを OFF にして入室しました', { exact: false }).waitFor({ timeout: 10_000 });
  // 本人は自分で ON に戻せる
  await b.page.getByRole('button', { name: /マイクON$/ }).click();
  assert.equal(await waitMic(b.page, 'on'), 'on', '本人がマイクを ON に戻せる');
  console.log('PASS 3: 録画中の入室はマイク OFF + お知らせ、本人は ON に戻せる');

  // 4) 収録モードだが録画していない: マイク ON で入室
  await broadcast(instructorJwt, { active: true, recording: false });
  const c = await joinAsStudent('student-c');
  assert.equal(await waitMic(c.page, 'on'), 'on', '収録モードでも録画していなければマイク ON');
  console.log('PASS 4: 収録モードでも録画していなければマイク ON で入室');

  await broadcast(instructorJwt, { active: false, recording: false });

  // 5) 講師が参加者タイルのマイクボタンで OFF にできる
  const t = await joinAs('instructor', 'instructor');
  const tileMic = t.page.getByTestId('tile-mic-toggle').and(t.page.getByRole('button', { name: 'student-cのマイクをOFFにする' }));
  await tileMic.waitFor({ timeout: 30_000 });
  await tileMic.click();
  assert.equal(await waitMic(c.page, 'off'), 'off', 'タイルのボタンで受講生のマイクが OFF になる');
  await t.page.getByTestId('tile-mic-toggle').and(t.page.getByRole('button', { name: 'student-cのマイクをONにする' })).waitFor({ timeout: 15_000 });
  console.log('PASS 5: 講師が参加者タイルのボタンで受講生のマイクを OFF にできる (表示も OFF に変わる)');

  for (const s of [a, b, c, t]) assert.deepEqual(s.errors, [], 'ページの実行時エラーがない');
  console.log('PASS: all');
} finally {
  await browser.close();
  stopServer();
}
