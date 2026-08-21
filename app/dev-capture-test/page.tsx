'use client';

/**
 * Element Capture (restrictTo) の自動検証用ページ（開発時のみ / 本番ビルドでは 404）。
 *
 * 収録ステージを「重なった UI ごと録る」Region Capture から
 * 「対象要素のサブツリーだけを録る」Element Capture へ移せたかを、
 * 実 Chromium で機械的に確かめるための最小再現環境。
 *
 *   検証: `node scripts/verify-element-capture.mjs`（dev サーバーの起動も同スクリプトが行う）
 *
 * 実 UI (RoomView の収録モード) と揃えてある構造:
 *   - ステージは `isolate` (Element Capture の必須要件) な 16:9 要素
 *   - サイドパネルは左端・右端の `position: fixed` オーバーレイ。フロー外なので
 *     開閉してもステージの bounding box は動かない
 *   - パネル開閉の封鎖条件は RoomView と同じ式:
 *       panelsLocked = isStarting || (isRecording && captureExclusionMode !== 'element')
 *   - region フォールバックで録画が始まったらパネルを強制的に閉じる
 *
 * ステージの中身も実物に寄せてある。実 StudioStage には
 *   ①LiveKit の参加者タイル = 再生中の `<video>`
 *   ②AiEnergyOrb = requestAnimationFrame で描き続ける `<canvas>`
 * が存在し、これらは合成レイヤを作るため Element Capture の適格性に影響し得る。
 * ここでは getUserMedia を使わず `canvas.captureStream()` を `<video>` に流して再現する。
 *
 * 判定を色で行うため、ステージ地は純色 #16a34a、パネルは純色 #ff00ff にしてある。
 * Element Capture が効いていれば、パネルを開いてもキャプチャ映像に #ff00ff は現れず、
 * かつパネルがレイアウトに参加しない（position: fixed）ので出力解像度も動かない。
 */

import { useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import { useLocalRecording } from '@/hooks/useLocalRecording';

/**
 * このページのタブタイトル。
 * scripts/verify-element-capture.mjs が Chromium の
 * `--auto-select-tab-capture-source-by-title` に同じ文字列を渡して
 * getDisplayMedia のピッカーを自動応答させるので、両者は一致していること。
 */
const PAGE_TITLE = 'dev-capture-test';

export default function DevCaptureTestPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  const stageRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  /** ステージ内の「参加者タイル」相当。canvas.captureStream() を流して再生し続ける */
  const tileVideoRef = useRef<HTMLVideoElement | null>(null);
  /** ステージ内の「AiEnergyOrb」相当。rAF で描き続ける */
  const orbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** getDisplayMedia が返したキャプチャストリーム（フックは外へ公開しないので横取りする） */
  const capturedRef = useRef<MediaStream | null>(null);

  /** 左端のチャットパネル相当 (実 UI の StudioChatPanel) */
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  /** 右端の AI 設定パネル相当 (実 UI の AiParticipantSetupModal) */
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  /** false にするとステージを DOM から外す（fail-closed の確認用） */
  const [stageMounted, setStageMounted] = useState(true);
  const [trackSize, setTrackSize] = useState<string>('-');
  /** ステージ内の <video> が実際に再生できているか (ステージ内容の近似が成立しているかの確認) */
  const [videoPlaying, setVideoPlaying] = useState(false);

  const { isRecording, isStarting, error, captureExclusionMode, regionCaptureActive, start, stop } =
    useLocalRecording({
      filePrefix: 'dev-capture-test',
      // マイクを開くと検証環境ごとに挙動が変わる。映像の検証だけなので閉じておく。
      includeMicrophone: false,
    });

  /**
   * パネルを開閉できるか。RoomView の panelsLocked と同じ式にしてあること
   * （この検証はこの式そのものを機械判定するためにある）。
   */
  const panelsLocked = isStarting || (isRecording && captureExclusionMode !== 'element');

  useEffect(() => {
    // 検証スクリプトはこのタイトルで getDisplayMedia のピッカーを自動応答させるので、
    // 確実に反映されている必要がある。ただし layout の metadata (title) が
    // ハイドレーション後に React 側から書き戻されるため、一度の代入では負ける。
    // クライアント専用ページで metadata を宣言する手段が無いので、再表明で押さえる。
    const apply = () => {
      if (document.title !== PAGE_TITLE) document.title = PAGE_TITLE;
    };
    apply();
    const id = window.setInterval(apply, 200);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // フックはキャプチャストリームを返さない（本番では不要なため）。
    // 検証にはフレームのピクセルとトラック settings が要るので、
    // このページに限り getDisplayMedia を包んでストリームを掴んでおく。
    const md = navigator.mediaDevices;
    const original = md.getDisplayMedia.bind(md);
    const patched = async (options?: DisplayMediaStreamOptions) => {
      const stream = await original(options);
      capturedRef.current = stream;
      queueMicrotask(() => {
        const v = previewRef.current;
        if (!v) return;
        v.srcObject = stream;
        void v.play().catch(() => {});
      });
      return stream;
    };
    (md as unknown as Record<string, unknown>).getDisplayMedia = patched;
    return () => {
      (md as unknown as Record<string, unknown>).getDisplayMedia = original;
    };
  }, []);

  useEffect(() => {
    // ステージの中身を実物に寄せる。
    // ① 参加者タイル相当: オフスクリーン canvas の captureStream() を <video> へ流す。
    //    getUserMedia を使わずに「再生中の video 要素」を作れる。
    // ② AiEnergyOrb 相当: ステージ内の <canvas> を rAF で描き続ける。
    // どちらもステージの中で合成レイヤを作るので、これらを含んだ状態で
    // Element Capture が成立することを確かめる意味がある。
    if (!stageMounted) return;

    const src = document.createElement('canvas');
    src.width = 320;
    src.height = 180;
    const srcCtx = src.getContext('2d');
    const stream = src.captureStream(30);
    const tile = tileVideoRef.current;
    if (tile) {
      tile.srcObject = stream;
      void tile.play().catch(() => {});
    }

    let raf = 0;
    const draw = (t: number) => {
      if (srcCtx) {
        srcCtx.fillStyle = '#1e3a8a';
        srcCtx.fillRect(0, 0, src.width, src.height);
        srcCtx.fillStyle = '#f97316';
        srcCtx.fillRect((t / 8) % src.width, 70, 48, 48);
      }
      const orb = orbCanvasRef.current;
      const orbCtx = orb?.getContext('2d');
      if (orb && orbCtx) {
        orbCtx.fillStyle = '#0f172a';
        orbCtx.fillRect(0, 0, orb.width, orb.height);
        orbCtx.beginPath();
        orbCtx.arc(orb.width / 2, orb.height / 2, 18 + 8 * Math.sin(t / 300), 0, Math.PI * 2);
        orbCtx.fillStyle = '#38bdf8';
        orbCtx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const probe = window.setInterval(() => {
      const v = tileVideoRef.current;
      setVideoPlaying(!!v && !v.paused && v.readyState >= 2 && v.videoWidth > 0);
    }, 200);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(probe);
      stream.getTracks().forEach((tr) => tr.stop());
      setVideoPlaying(false);
    };
  }, [stageMounted]);

  useEffect(() => {
    // トラックの解像度はキャプチャ開始後に Chromium 側で更新されることがあるので、
    // 一度読むだけでは足りない。録画中はポーリングして表示を追従させる。
    const read = () => {
      const s = isRecording ? capturedRef.current?.getVideoTracks()[0]?.getSettings() : undefined;
      setTrackSize(s?.width && s?.height ? `${s.width}x${s.height}` : '-');
    };
    const id = window.setInterval(read, 200);
    return () => window.clearInterval(id);
  }, [isRecording]);

  useEffect(() => {
    // region フォールバック時の強制クローズ (RoomView と同じ挙動)。
    // region は矩形を覆うピクセルをそのまま録るため、重ねたパネルが収録物に焼き込まれる。
    if (!isRecording || captureExclusionMode !== 'region') return;
    queueMicrotask(() => {
      setChatPanelOpen(false);
      setAiPanelOpen(false);
    });
  }, [isRecording, captureExclusionMode]);

  return (
    // ページ自体はスクロールさせない。スクロールするとステージが動き、
    // Playwright の自動スクロールが検証結果に混ざる。
    <div className="relative h-dvh overflow-hidden bg-black text-stone-100">
      {/* ステージ相当。aspect-video / isolate（Element Capture の必須要件）/ 純色。
          ページ左上に置き、左右のパネルが両端から食い込む座標にしてある。 */}
      {stageMounted && (
        <div
          ref={stageRef}
          data-testid="stage"
          className="relative isolate aspect-video w-[1000px] bg-[#16a34a]"
        >
          <video
            ref={tileVideoRef}
            data-testid="stage-video"
            autoPlay
            muted
            playsInline
            className="absolute left-2 top-2 h-[90px] w-[160px] object-cover"
          />
          <canvas
            ref={orbCanvasRef}
            data-testid="stage-canvas"
            width={160}
            height={90}
            className="absolute left-[180px] top-2 h-[90px] w-[160px]"
          />
        </div>
      )}

      {/* 左端 / 右端の全高オーバーレイ（実 UI のチャット・AI設定パネル相当）。
          position: fixed なのでレイアウトに参加せず、開閉してもステージは伸縮しない
          （= 出力解像度が変わらない）。どちらもステージに視覚的に食い込む位置。 */}
      {chatPanelOpen && (
        <aside
          data-testid="chat-panel"
          className="fixed inset-y-0 left-0 z-40 w-[320px] bg-[#ff00ff]"
        />
      )}
      {aiPanelOpen && (
        <aside
          data-testid="ai-panel"
          className="fixed inset-y-0 right-0 z-40 w-[400px] bg-[#ff00ff]"
        />
      )}

      {/* 操作パネル。パネルを開いてもボタンを押せるよう、左右のオーバーレイの
          内側の帯 (x: 336〜864) に固定する。fixed なのでページ高にも影響しない。 */}
      <div className="fixed bottom-0 left-[336px] right-[416px] z-50 space-y-1 bg-black/80 p-2 text-sm">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="start-recording"
            onClick={() => void start('streaming', () => stageRef.current)}
            className="rounded bg-red-600 px-3 py-1 font-medium disabled:opacity-40"
            disabled={isRecording || isStarting}
          >
            録画開始
          </button>
          <button
            type="button"
            data-testid="stop-recording"
            onClick={() => void stop()}
            className="rounded bg-stone-700 px-3 py-1 font-medium disabled:opacity-40"
            disabled={!isRecording}
          >
            録画停止
          </button>
          <button
            type="button"
            data-testid="toggle-chat-panel"
            onClick={() => {
              if (panelsLocked) return;
              setChatPanelOpen((v) => !v);
            }}
            disabled={panelsLocked}
            className="rounded bg-fuchsia-700 px-3 py-1 font-medium disabled:opacity-40"
          >
            チャット
          </button>
          <button
            type="button"
            data-testid="toggle-ai-panel"
            onClick={() => {
              if (panelsLocked) return;
              setAiPanelOpen((v) => !v);
            }}
            disabled={panelsLocked}
            className="rounded bg-fuchsia-700 px-3 py-1 font-medium disabled:opacity-40"
          >
            AI設定
          </button>
          <button
            type="button"
            data-testid="toggle-stage"
            onClick={() => setStageMounted((v) => !v)}
            className="rounded bg-stone-700 px-3 py-1 font-medium"
          >
            ステージ
          </button>
        </div>

        <dl className="grid grid-cols-[11rem_1fr] gap-x-3 font-mono text-[10px] leading-tight">
          <dt>captureExclusionMode</dt>
          <dd data-testid="capture-exclusion-mode">{captureExclusionMode ?? 'none'}</dd>
          <dt>regionCaptureActive</dt>
          <dd data-testid="region-capture-active">{String(regionCaptureActive)}</dd>
          <dt>isRecording</dt>
          <dd data-testid="is-recording">{String(isRecording)}</dd>
          <dt>isStarting</dt>
          <dd data-testid="is-starting">{String(isStarting)}</dd>
          <dt>panelsLocked</dt>
          <dd data-testid="panels-locked">{String(panelsLocked)}</dd>
          <dt>track width x height</dt>
          <dd data-testid="track-size">{trackSize}</dd>
          <dt>chat panel</dt>
          <dd data-testid="chat-panel-state">{String(chatPanelOpen)}</dd>
          <dt>ai panel</dt>
          <dd data-testid="ai-panel-state">{String(aiPanelOpen)}</dd>
          <dt>stage mounted</dt>
          <dd data-testid="stage-mounted">{String(stageMounted)}</dd>
          <dt>stage video playing</dt>
          <dd data-testid="stage-video-playing">{String(videoPlaying)}</dd>
          <dt>error</dt>
          <dd data-testid="recording-error">{error ?? ''}</dd>
        </dl>

        {/* キャプチャ映像のプレビュー。検証スクリプトはここから canvas へ描いて
            ピクセルを読む。ステージの外に置くこと（中に置くと自己参照になる）。 */}
        <video
          ref={previewRef}
          data-testid="capture-preview"
          autoPlay
          muted
          playsInline
          className="w-[140px] border border-stone-700"
        />
      </div>
    </div>
  );
}
