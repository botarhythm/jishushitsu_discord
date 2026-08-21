/**
 * Element Capture (restrictTo) 経路の自動検証。
 *
 * 使い方:
 *   node scripts/verify-element-capture.mjs
 *   （dev サーバーはこのスクリプトが port 3101 で起動し、終了時に落とす。
 *     3100 は開発用に使うので踏まない）
 *
 * 何を確かめるか — 収録の実害は「録画中に出力解像度が変わって WebM が壊れる」ことと
 * 「映ってはいけない UI が録画に混入する」ことの2つ。Element Capture は
 * 対象要素のサブツリーだけを録るので、重なる UI を position: fixed にしておけば
 * その両方が同時に解決する。本スクリプトはそれを実 Chromium で機械判定する。
 *
 *   a. 録画開始後 captureExclusionMode === 'element'
 *      （ステージ内に再生中の <video> と rAF 描画の <canvas> がある状態で。
 *        実 StudioStage の子要素種別を含めた適格性の近似）
 *   b. サイドパネルを開いてもトラックの width/height が変わらない
 *   c. パネルを開いた状態のキャプチャフレームに #ff00ff 系ピクセルが無い
 *   d. RestrictionTarget を消した2回目のランで 'region' へ落ちる（フォールバック生存）
 *   e. さらにステージを DOM から外すと録画が始まらず error に「中止」が出る（fail-closed 生存）
 *   f. element モードの録画中にパネルを開閉しても、トラック解像度が変わらず・録画が続き・
 *      新しいエラーも出ない（= 録画中の封鎖を解除してよいことの根拠）
 *   g. region モードの録画中はパネル開閉ボタンが DOM 上で disabled であり、
 *      開いていたパネルは強制的に閉じられる（フォールバック時の封鎖維持）
 *   h. 録画中に AI 参加者を ON/OFF しても録画が壊れず、収録音声の中身が切り替わる。
 *      タブ音声 440Hz / AI 音声 880Hz を鳴らし分け、保存された WebM を
 *      OfflineAudioContext + bandpass で帯域 RMS にしてフェーズごとに判定する
 *      （audioDynamicSwitch）
 *   i. element / region どちらの録画中でも AI 参加者トグルが DOM 上 disabled でない
 *      （音声の切替はクロップ方式に依存しない / aiToggleUnlockedWhileRecording）
 *
 * すべて満たせば exit 0。ひとつでも欠ければ exit 1。結果 JSON を stdout に出す。
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';

const PORT = 3101;
// 127.0.0.1 だと Next 16 の dev サーバーがクロスオリジン扱いで
// クライアントチャンクを 403 にし、ハイドレーションが走らない (= effect が動かない)。
// localhost を使うこと。
const BASE = `http://localhost:${PORT}`;
const PAGE_PATH = '/dev-capture-test';
/** app/dev-capture-test/page.tsx が document.title に設定する文字列と一致させること */
const PAGE_TITLE = 'dev-capture-test';
/** サイドパネルの色 (#ff00ff)。この色がフレームに出たら Element Capture が効いていない */
const OVERLAY_RGB = [255, 0, 255];
const COLOR_TOLERANCE = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── dev サーバー ───────────────────────────────────────────────

/**
 * port が空いていることを先に確かめる。
 * 埋まっていると next dev が黙って別の port へ逃げ、
 * 「別プロセスの古いページを検証してしまう」事故になる。
 */
async function assertPortFree() {
  try {
    await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    return; // 応答が無い = 空いている
  }
  throw new Error(
    `port ${PORT} が既に使われています。残っているプロセスを止めてから再実行してください。`
  );
}

function startDevServer() {
  const proc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT)], {
    cwd: process.cwd(),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  return { proc, log };
}

async function waitForServer(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // 実際の検証ページを叩いておく。dev の初回コンパイルをここで済ませ、
      // ブラウザ側のタイムアウトに巻き込まないため。
      const res = await fetch(`${BASE}${PAGE_PATH}`);
      if (res.ok) return true;
    } catch {
      // まだ起動していない
    }
    await sleep(500);
  }
  return false;
}

function killDevServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    // next dev は子プロセスを持つので、ツリーごと落とさないと 3101 が空かない。
    // 同期実行にすること — 直後に process.exit() するので、非同期 spawn では
    // taskkill が起動する前にこのプロセスが消え、dev サーバーが残留する。
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
}

// ── ページ操作ヘルパ ───────────────────────────────────────────

const readState = (page, testid) =>
  page.locator(`[data-testid="${testid}"]`).innerText();

async function waitForState(page, testid, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = (await readState(page, testid)).trim();
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`${label}: "${testid}" が条件を満たしませんでした (最後の値: "${last}")`);
}

/**
 * トラックの width/height が落ち着くまで待つ。
 * キャプチャ開始直後は Chromium 側でフレームサイズが一度更新される
 * (論理サイズ → デバイスピクセル比を反映した実サイズ) ため、
 * ここを待たずに基準値を取ると「オーバーレイのせい」ではない変化を拾ってしまう。
 */
async function waitForStableTrackSize(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let value = '-';
  while (Date.now() < deadline) {
    const now = (await readState(page, 'track-size')).trim();
    stable = now === value && now !== '-' ? stable + 1 : 0;
    value = now;
    if (stable >= 5) return value; // 200ms x 5 = 1秒 変化なし
    await sleep(200);
  }
  throw new Error(`トラック解像度が安定しませんでした (最後の値: "${value}")`);
}

/**
 * キャプチャ映像（= ステージ）の全面から 25 点サンプルする。
 * 左端パネル (x 0〜320px) と右端パネル (x 880〜1280px) の両方がステージに食い込む
 * 座標にしてあるので、左右どちらの列にもパネル色が出ないことを一度に見られる。
 */
async function sampleStage(page) {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="capture-preview"]');
    if (!v || !v.videoWidth || !v.videoHeight) return { error: 'キャプチャ映像のフレームがありません' };
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0);
    const points = [];
    for (let iy = 0; iy < 5; iy++) {
      for (let ix = 0; ix < 5; ix++) {
        // フレーム全面を 5x5 に割って各セルの中心を取る
        const x = Math.min(c.width - 1, Math.round(c.width * ((ix + 0.5) / 5)));
        const y = Math.min(c.height - 1, Math.round(c.height * ((iy + 0.5) / 5)));
        const d = g.getImageData(x, y, 1, 1).data;
        points.push([d[0], d[1], d[2]]);
      }
    }
    return { width: c.width, height: c.height, points };
  });
}

/**
 * パネルがステージ矩形に実際に食い込んでいるかを DOM の座標で確かめる。
 * ここが false だと「パネル色が映らない」は Element Capture の効果ではなく
 * 単に重なっていないだけになり、色の判定が無意味になる（将来のレイアウト変更への防波堤）。
 */
async function measurePanelOverlap(page) {
  return page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const stage = rect('[data-testid="stage"]');
    const overlapPx = (panel) => {
      if (!stage || !panel) return 0;
      const w = Math.min(stage.right, panel.right) - Math.max(stage.left, panel.left);
      const h = Math.min(stage.bottom, panel.bottom) - Math.max(stage.top, panel.top);
      return w > 0 && h > 0 ? Math.round(w) : 0;
    };
    return {
      stage,
      chatOverlapPx: overlapPx(rect('[data-testid="chat-panel"]')),
      aiOverlapPx: overlapPx(rect('[data-testid="ai-panel"]')),
    };
  });
}

const isOverlayColor = ([r, g, b]) =>
  Math.abs(r - OVERLAY_RGB[0]) <= COLOR_TOLERANCE &&
  Math.abs(g - OVERLAY_RGB[1]) <= COLOR_TOLERANCE &&
  Math.abs(b - OVERLAY_RGB[2]) <= COLOR_TOLERANCE;

/**
 * 収録された WebM をページ内で復号し、フェーズごとの帯域 RMS を測る。
 *
 * 「録画中に AI 参加者を ON/OFF しても音声が二重にならない/欠落しない」は
 * 目視では確かめられない。タブ音声を 440Hz、AI 音声を 880Hz にしておけば、
 * 収録物のどの区間にどちらの音が入っているかを数値で判定できる。
 *
 * 境界の前後 guardMs は測定から外す。ゲートの遷移 (時定数 20ms) と、
 * ページ側の時刻 (Date.now) と収録タイムラインの微小なずれを吸収するため。
 */
async function analyzeAudioRun(page, { guardMs = 300, tabHz = 440, aiHz = 880 } = {}) {
  return page.evaluate(
    async ({ guardMs, tabHz, aiHz }) => {
      const run = window.__audioRun;
      if (!run) return { error: '録画結果がページから受け渡されていません' };
      if (!run.blob) return { error: '録画 Blob が null です' };
      const m = run.marks;
      if (!m.startedAt || !m.aiOnAt || !m.aiOffAt || !m.stopRequestedAt) {
        return { error: `フェーズ境界が欠けています: ${JSON.stringify(m)}` };
      }
      const buf = await run.blob.arrayBuffer();
      const ctx = new AudioContext();
      let audio;
      try {
        audio = await ctx.decodeAudioData(buf);
      } catch (e) {
        return {
          error: `decodeAudioData に失敗: ${String(e)}`,
          blobSize: run.blob.size,
          blobType: run.blob.type,
        };
      } finally {
        void ctx.close();
      }

      /** 指定区間をモノラルに畳んで bandpass に通し、RMS を返す */
      const bandRms = async (from, to, freq) => {
        const sr = audio.sampleRate;
        const s = Math.max(0, Math.floor(from * sr));
        const e = Math.min(audio.length, Math.floor(to * sr));
        const len = e - s;
        // Q=30 の bandpass はリンギングが長い。短すぎる区間は測らない。
        if (len < sr * 0.3) return null;
        const off = new OfflineAudioContext(1, len, sr);
        const sliced = off.createBuffer(1, len, sr);
        const out = sliced.getChannelData(0);
        for (let c = 0; c < audio.numberOfChannels; c++) {
          const src = audio.getChannelData(c);
          for (let i = 0; i < len; i++) out[i] += src[s + i] / audio.numberOfChannels;
        }
        const node = off.createBufferSource();
        node.buffer = sliced;
        const filter = off.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = freq;
        filter.Q.value = 30;
        node.connect(filter);
        filter.connect(off.destination);
        node.start();
        const rendered = await off.startRendering();
        const d = rendered.getChannelData(0);
        // フィルタの立ち上がり (100ms) は捨てる
        const skip = Math.min(d.length - 1, Math.floor(sr * 0.1));
        let sum = 0;
        for (let i = skip; i < d.length; i++) sum += d[i] * d[i];
        return Math.sqrt(sum / (d.length - skip));
      };

      const rel = (t) => (t - m.startedAt) / 1000;
      const guard = guardMs / 1000;
      const bounds = [
        { name: 'phase1_aiOff', from: 0, to: rel(m.aiOnAt) },
        { name: 'phase2_aiOn', from: rel(m.aiOnAt), to: rel(m.aiOffAt) },
        { name: 'phase3_aiOff', from: rel(m.aiOffAt), to: rel(m.stopRequestedAt) },
      ];
      const phases = [];
      for (const b of bounds) {
        const from = Math.max(0, b.from + guard);
        const to = Math.min(audio.duration, b.to - guard);
        phases.push({
          name: b.name,
          from: Number(from.toFixed(3)),
          to: Number(to.toFixed(3)),
          tabRms: await bandRms(from, to, tabHz),
          aiRms: await bandRms(from, to, aiHz),
        });
      }
      return {
        duration: Number(audio.duration.toFixed(3)),
        sampleRate: audio.sampleRate,
        channels: audio.numberOfChannels,
        blobSize: run.blob.size,
        phases,
      };
    },
    { guardMs, tabHz, aiHz }
  );
}

/**
 * 検証ページを開いたブラウザを用意する。
 * removeRestrictionTarget を立てると Element Capture 非対応環境を再現する。
 */
async function openPage({ removeRestrictionTarget, withAudio = false }) {
  const browser = await chromium.launch({
    // 既定の headless shell では getDisplayMedia のタブキャプチャが使えない。
    // channel: 'chromium' はフルビルドの Chromium を新ヘッドレス (headless=new) で起動する。
    channel: 'chromium',
    // Playwright は headless 起動時に既定で --mute-audio を足す。これが付いていると
    // タブが音を鳴らしていても getDisplayMedia のタブ音声トラックは**完全な無音**になる
    // (トラック自体は live:unmuted で取れるので、外から見ると切替の失敗と区別できない)。
    // 音声ランだけ外す。外すと実際にスピーカーから 440Hz が鳴る。
    ...(withAudio ? { ignoreDefaultArgs: ['--mute-audio'] } : {}),
    args: [
      // getDisplayMedia のピッカーを、このタイトルのタブで自動応答させる
      `--auto-select-tab-capture-source-by-title=${PAGE_TITLE}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  if (removeRestrictionTarget) {
    await page.addInitScript(() => {
      delete window.RestrictionTarget;
    });
  }
  // ?audio=1 のときだけページがタブ音声トーンを鳴らす
  await page.goto(`${BASE}${PAGE_PATH}${withAudio ? '?audio=1' : ''}`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="start-recording"]').waitFor({ timeout: 60_000 });
  // タイトルはハイドレーション後の effect で設定される (layout の metadata を上書きする)。
  // ここが一致していないと getDisplayMedia のピッカーが自動応答されず必ず詰まるので、
  // 待ってから確認し、駄目なら理由が分かる形で落とす。
  try {
    await page.waitForFunction(
      (expected) => document.title === expected,
      PAGE_TITLE,
      { timeout: 30_000 }
    );
  } catch {
    const title = await page.title();
    await browser.close();
    throw new Error(
      `検証ページの document.title が "${title}" のままでした。--auto-select-tab-capture-source-by-title に渡した "${PAGE_TITLE}" と一致しません。`
    );
  }
  return { browser, page };
}

// ── ラン ───────────────────────────────────────────────────────

/** ラン1: Element Capture 本命経路 (a / b / c / f) */
async function runElementCapture(details) {
  const { browser, page } = await openPage({ removeRestrictionTarget: false });
  const chatToggle = page.locator('[data-testid="toggle-chat-panel"]');
  const aiToggle = page.locator('[data-testid="toggle-ai-panel"]');
  /** 両パネルを一度に開閉する。disabled なら click がタイムアウトして失敗する（＝封鎖の検知） */
  const setPanels = async (open) => {
    await chatToggle.click({ timeout: 5_000 });
    await aiToggle.click({ timeout: 5_000 });
    await waitForState(page, 'chat-panel-state', (v) => v === String(open), 5_000, 'ラン1(チャットパネル)');
    await waitForState(page, 'ai-panel-state', (v) => v === String(open), 5_000, 'ラン1(AI設定パネル)');
  };
  try {
    // ステージ内の <video>（captureStream 再生）と <canvas>（rAF 描画）が動いてから開始する。
    // 実 StudioStage には両方が存在するので、これらを含んだ状態で element 適格性を見る。
    await waitForState(
      page,
      'stage-video-playing',
      (v) => v === 'true',
      20_000,
      'ラン1(ステージ内 video の再生)'
    );
    details.run1 = { stageVideoPlaying: true };

    await page.locator('[data-testid="start-recording"]').click();
    await waitForState(page, 'is-recording', (v) => v === 'true', 30_000, 'ラン1(録画開始)');

    const mode = (await readState(page, 'capture-exclusion-mode')).trim();
    details.run1.mode = mode;
    const elementMode = mode === 'element';

    const sizeBefore = await waitForStableTrackSize(page);
    details.run1.panelsLocked = (await readState(page, 'panels-locked')).trim();
    // i: 録画中でも AI 参加者の切替は封鎖しない (音声の話なのでクロップ方式に依存しない)
    details.run1.aiToggleDisabled = await page
      .locator('[data-testid="toggle-ai-participant"]')
      .isDisabled();
    await setPanels(true);
    await sleep(1_000); // 「開いた1秒後」に測る
    const sizeAfter = (await readState(page, 'track-size')).trim();
    details.run1.sizeBefore = sizeBefore;
    details.run1.sizeAfter = sizeAfter;
    const resolutionStable = sizeBefore !== '-' && sizeBefore === sizeAfter;

    // 「重なっていないから映らないだけ」を排除する。両パネルがステージに食い込んでいること。
    const overlap = await measurePanelOverlap(page);
    details.run1.overlap = overlap;
    const panelsOverlapStage = overlap.chatOverlapPx > 0 && overlap.aiOverlapPx > 0;

    const sample = await sampleStage(page);
    details.run1.sample = sample;
    const hits = sample.points?.filter(isOverlayColor) ?? [];
    details.run1.overlayColorHits = hits.length;
    const overlayExcluded =
      panelsOverlapStage && !sample.error && sample.points?.length === 25 && hits.length === 0;

    const errorBeforeToggles = (await readState(page, 'recording-error')).trim();
    details.run1.error = errorBeforeToggles;

    // ── f: 録画中のパネル開閉 ──
    // 閉じる → 開く → 閉じる を通しても、解像度が動かず・録画が続き・新しいエラーが出ないこと。
    // ボタンが disabled なら上の click がタイムアウトするので、封鎖されていないことも同時に見ている。
    let panelToggleDuringElementRecording = false;
    try {
      await setPanels(false);
      await sleep(700);
      await setPanels(true);
      await sleep(700);
      await setPanels(false);
      await sleep(700);
      const sizeAfterToggles = (await readState(page, 'track-size')).trim();
      const stillRecording = (await readState(page, 'is-recording')).trim();
      const errorAfterToggles = (await readState(page, 'recording-error')).trim();
      details.run1.toggle = {
        sizeAfterToggles,
        stillRecording,
        errorAfterToggles,
      };
      panelToggleDuringElementRecording =
        sizeAfterToggles === sizeBefore &&
        stillRecording === 'true' &&
        errorAfterToggles === '' &&
        errorBeforeToggles === '';
    } catch (e) {
      details.run1.toggleError = String(e);
    }

    // 停止経路も一度通しておく（保存処理で落ちないことの確認。判定には使わない）
    try {
      await page.locator('[data-testid="stop-recording"]').click({ timeout: 5_000 });
      await sleep(2_000);
      details.run1.errorAfterStop = (await readState(page, 'recording-error')).trim();
    } catch (e) {
      details.run1.stopError = String(e);
    }

    return {
      elementMode,
      resolutionStable,
      overlayExcluded,
      panelToggleDuringElementRecording,
    };
  } finally {
    await browser.close();
  }
}

/** ラン2: RestrictionTarget を消して Region Capture へ落ちるか (d) と、その間の封鎖 (g) */
async function runRegionFallback(details) {
  const { browser, page } = await openPage({ removeRestrictionTarget: true });
  try {
    const hasRT = await page.evaluate(() => typeof window.RestrictionTarget !== 'undefined');
    details.run2 = { restrictionTargetPresent: hasRT };

    // 録画開始前は開閉できる。開いた状態で始めて、強制クローズも同時に確かめる。
    await page.locator('[data-testid="toggle-chat-panel"]').click({ timeout: 5_000 });
    await page.locator('[data-testid="toggle-ai-panel"]').click({ timeout: 5_000 });
    await waitForState(page, 'chat-panel-state', (v) => v === 'true', 5_000, 'ラン2(チャットパネル)');
    await waitForState(page, 'ai-panel-state', (v) => v === 'true', 5_000, 'ラン2(AI設定パネル)');

    await page.locator('[data-testid="start-recording"]').click();
    await waitForState(page, 'is-recording', (v) => v === 'true', 30_000, 'ラン2(録画開始)');
    const mode = (await readState(page, 'capture-exclusion-mode')).trim();
    details.run2.mode = mode;

    // g: region 録画中は開閉ボタンが DOM 上で disabled であること
    const chatDisabled = await page.locator('[data-testid="toggle-chat-panel"]').isDisabled();
    const aiDisabled = await page.locator('[data-testid="toggle-ai-panel"]').isDisabled();
    const panelsLockedState = (await readState(page, 'panels-locked')).trim();
    details.run2.chatToggleDisabled = chatDisabled;
    details.run2.aiPanelToggleDisabled = aiDisabled;
    details.run2.panelsLocked = panelsLockedState;
    // i: パネル開閉は封鎖されるが、AI 参加者の ON/OFF は region でも封鎖しない
    details.run2.aiToggleDisabled = await page
      .locator('[data-testid="toggle-ai-participant"]')
      .isDisabled();

    // 開いていたパネルが強制的に閉じられていること（region はパネルが収録に焼き込まれる）
    const chatState = (await readState(page, 'chat-panel-state')).trim();
    const aiState = (await readState(page, 'ai-panel-state')).trim();
    details.run2.chatPanelState = chatState;
    details.run2.aiPanelState = aiState;

    return {
      fallbackRegionMode: !hasRT && mode === 'region',
      panelsLockedInRegionMode: chatDisabled && aiDisabled && panelsLockedState === 'true',
      panelsForceClosedInRegionMode: chatState === 'false' && aiState === 'false',
    };
  } finally {
    await browser.close();
  }
}

/** ラン3: ステージを DOM から外した状態で開始 → 録画されないこと (e) */
async function runFailClosed(details) {
  const { browser, page } = await openPage({ removeRestrictionTarget: true });
  try {
    await page.locator('[data-testid="toggle-stage"]').click();
    await waitForState(page, 'stage-mounted', (v) => v === 'false', 5_000, 'ラン3(ステージ取り外し)');

    await page.locator('[data-testid="start-recording"]').click();
    const message = await waitForState(
      page,
      'recording-error',
      (v) => v.length > 0,
      30_000,
      'ラン3(エラー表示)'
    );
    // 開始処理が終わるのを待ってから録画状態を見る
    await waitForState(page, 'is-starting', (v) => v === 'false', 10_000, 'ラン3(開始処理完了)');
    const recording = (await readState(page, 'is-recording')).trim();
    details.run3 = { message, isRecording: recording };
    return { failClosedOnMissingTarget: message.includes('中止') && recording === 'false' };
  } finally {
    await browser.close();
  }
}

/**
 * ラン4: 録画中の AI 参加者 ON/OFF で音声経路が動的に切り替わるか (h)
 *
 * シナリオ: 録画開始 (AI OFF) → 2秒 → AI ON → 2秒 → AI OFF → 2秒 → 停止。
 * 収録物のフェーズごとに 440Hz (タブ音声) と 880Hz (AI 音声) の RMS を測り、
 * 「AI ON でタブ音声が閉じ AI 音声が入る」「AI OFF でタブ音声が戻る」を判定する。
 *
 * 注意: このランだけ Chromium のミュートを外すため、実行中の約10秒間
 * 440Hz のトーンが実際にスピーカーから鳴る (音声出力デバイスが必要)。
 */
async function runAudioDynamicSwitch(details) {
  const { browser, page } = await openPage({ removeRestrictionTarget: false, withAudio: true });
  const aiToggle = page.locator('[data-testid="toggle-ai-participant"]');
  try {
    // タブ音声 (440Hz) が実際に鳴っている状態で始める。suspended のまま録ると
    // 全フェーズ無音になり、判定が「切替の失敗」と区別できなくなる。
    await waitForState(page, 'tone-state', (v) => v === 'running', 20_000, 'ラン4(タブ音声の再生)');
    details.run4 = { toneState: 'running' };

    await page.locator('[data-testid="start-recording"]').click();
    await waitForState(page, 'is-recording', (v) => v === 'true', 30_000, 'ラン4(録画開始)');
    details.run4.mode = (await readState(page, 'capture-exclusion-mode')).trim();

    await sleep(2_000); // フェーズ1: AI OFF
    await aiToggle.click({ timeout: 5_000 });
    await waitForState(page, 'ai-participant-state', (v) => v === 'true', 5_000, 'ラン4(AI ON)');
    await sleep(2_000); // フェーズ2: AI ON
    await aiToggle.click({ timeout: 5_000 });
    await waitForState(page, 'ai-participant-state', (v) => v === 'false', 5_000, 'ラン4(AI OFF)');
    await sleep(2_000); // フェーズ3: AI OFF

    const stillRecording = (await readState(page, 'is-recording')).trim();
    const errorDuringRun = (await readState(page, 'recording-error')).trim();
    details.run4.stillRecording = stillRecording;
    details.run4.error = errorDuringRun;

    await page.locator('[data-testid="stop-recording"]').click({ timeout: 5_000 });
    await waitForState(page, 'audio-run-ready', (v) => v === 'true', 60_000, 'ラン4(録画の確定)');

    const analysis = await analyzeAudioRun(page);
    details.run4.analysis = analysis;
    if (analysis.error) return { audioDynamicSwitch: false };

    const [p1, p2, p3] = analysis.phases;
    const base = p1?.tabRms ?? 0;
    const ratios = {
      // 各値をフェーズ1のタブ音声 (基準値) との比で見る
      phase1_ai: base > 0 ? p1.aiRms / base : null,
      phase2_tab: base > 0 ? p2.tabRms / base : null,
      phase2_ai: base > 0 ? p2.aiRms / base : null,
      phase3_tab: base > 0 ? p3.tabRms / base : null,
      phase3_ai: base > 0 ? p3.aiRms / base : null,
    };
    details.run4.base440Rms = base;
    details.run4.ratios = ratios;

    const audioDynamicSwitch =
      base > 0 &&
      stillRecording === 'true' &&
      errorDuringRun === '' &&
      ratios.phase1_ai < 0.05 && // フェーズ1: AI 音声は入っていない
      ratios.phase2_tab < 0.1 && // フェーズ2: タブ音声のゲートが閉じている
      ratios.phase2_ai > 0.3 && // フェーズ2: AI 音声が基準と同オーダーで入っている
      ratios.phase2_ai < 3 &&
      ratios.phase3_tab > 0.5 && // フェーズ3: タブ音声が戻っている
      ratios.phase3_ai < 0.05; // フェーズ3: AI 音声は抜けている

    return { audioDynamicSwitch };
  } finally {
    await browser.close();
  }
}

// ── main ──────────────────────────────────────────────────────

const main = async () => {
  const details = {};
  try {
    await assertPortFree();
  } catch (e) {
    console.log(JSON.stringify({ ok: false, details: { fatal: String(e.message ?? e) } }, null, 2));
    process.exit(1);
  }
  const { proc, log } = startDevServer();
  let result = {
    elementMode: false,
    resolutionStable: false,
    overlayExcluded: false,
    panelToggleDuringElementRecording: false,
    fallbackRegionMode: false,
    panelsLockedInRegionMode: false,
    panelsForceClosedInRegionMode: false,
    failClosedOnMissingTarget: false,
    audioDynamicSwitch: false,
    aiToggleUnlockedWhileRecording: false,
  };
  try {
    if (!(await waitForServer())) {
      throw new Error(
        `dev サーバーが ${BASE} で応答しませんでした。\n--- dev log ---\n${log.join('').slice(-4000)}`
      );
    }
    result = { ...result, ...(await runElementCapture(details)) };
    result = { ...result, ...(await runRegionFallback(details)) };
    result = { ...result, ...(await runFailClosed(details)) };
    result = { ...result, ...(await runAudioDynamicSwitch(details)) };
    // i: element / region どちらの録画中でも AI トグルが押せること。
    // 両ランで DOM を見ているので、ここで突き合わせて 1 項目にまとめる。
    result.aiToggleUnlockedWhileRecording =
      details.run1?.aiToggleDisabled === false && details.run2?.aiToggleDisabled === false;
  } catch (e) {
    details.fatal = e instanceof Error ? `${e.message}` : String(e);
  } finally {
    killDevServer(proc);
  }

  const ok = Object.values(result).every(Boolean);
  console.log(JSON.stringify({ ...result, ok, details }, null, 2));
  process.exit(ok ? 0 : 1);
};

main();
