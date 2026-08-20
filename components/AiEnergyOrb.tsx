'use client';

import { useEffect, useRef } from 'react';
import type { AiTileState } from '@/lib/studio-participants';

/**
 * AI 参加者を表す「浮遊するエネルギー球」。
 *
 * 収録レイアウトを占有せず、人物2名の画面比率を保ったまま中央に重ねて表示する。
 * 発話中は外周がめらめらと揺らぎ、発光が強まる。
 *
 * 描画は Canvas 2D。録画はブラウザの DOM をそのままキャプチャするため、
 * ここで描いた絵はそのまま収録・配信に乗る。
 * 揺らぎは音声の RMS レベル（100ms 間隔で算出済み）で駆動する。
 */
export function AiEnergyOrb({ state }: { state: AiTileState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 描画ループから最新値を読むための箱（再レンダリングでループを切らさない）
  const levelRef = useRef(0);
  const stateRef = useRef(state.visualState);

  useEffect(() => {
    levelRef.current = state.level;
    stateRef.current = state.visualState;
  }, [state.level, state.visualState]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let smooth = 0;
    const start = performance.now();

    /**
     * 外周の揺らぎ。無理数比に近い周波数の正弦波を重ねて、
     * 周期の見えないゆらぎを作る（外部ライブラリを持ち込まないため）。
     */
    const wobble = (a: number, t: number, seed: number) =>
      Math.sin(a * 3 + t * 1.1 + seed) * 0.55 +
      Math.sin(a * 5 - t * 1.73 + seed * 2.3) * 0.3 +
      Math.sin(a * 8 + t * 2.61 + seed * 4.1) * 0.15;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const t = (performance.now() - start) / 1000;

      // レベルの平滑化。立ち上がりは速く、消えるのはゆっくり（火が消え残る感じ）
      const target = stateRef.current === 'speaking' ? levelRef.current : 0;
      const k = target > smooth ? 0.35 : 0.06;
      smooth += (target - smooth) * k;
      const lv = Math.min(1, smooth * 1.6);

      const isError = stateRef.current === 'error';

      ctx.clearRect(0, 0, w, h);

      // ゆっくり浮遊させる
      const cx = w / 2 + Math.sin(t * 0.31) * w * 0.012;
      const cy = h / 2 + Math.cos(t * 0.23) * h * 0.018;

      // 呼吸 + 発話による膨張
      const base = Math.min(w, h) * 0.3;
      const R = base * (1 + Math.sin(t * 0.8) * 0.045 + lv * 0.2);

      const hueShift = isError ? 0 : 1;

      // ── 外側のブルーム ──
      const bloom = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 2.5);
      bloom.addColorStop(0, `rgba(90, 190, 255, ${(0.22 + lv * 0.3) * hueShift})`);
      bloom.addColorStop(0.45, `rgba(120, 110, 255, ${(0.12 + lv * 0.18) * hueShift})`);
      bloom.addColorStop(1, 'rgba(60, 60, 160, 0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 2.5, 0, Math.PI * 2);
      ctx.fill();

      // ── コロナ（揺らぐ外周）──
      // 2枚重ねて、内側は落ち着き、外側ほど激しく揺れるようにする
      const coronaLayers = [
        { scale: 1.32, seed: 0.0, alpha: 0.3, amp: 0.1 },
        { scale: 1.1, seed: 2.7, alpha: 0.5, amp: 0.07 },
      ];
      for (const layer of coronaLayers) {
        ctx.beginPath();
        const steps = 160;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          // 発話中ほど高周波成分が増え「めらめら」した縁になる
          const idle = layer.amp * wobble(a, t * 0.5, layer.seed);
          const flame = lv * 0.34 * wobble(a, t * 2.2, layer.seed + 1.3);
          const r = R * layer.scale * (1 + idle + flame);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * layer.scale * 1.4);
        g.addColorStop(0, `rgba(150, 235, 255, ${layer.alpha * (0.5 + lv * 0.5) * hueShift})`);
        g.addColorStop(0.6, `rgba(80, 150, 255, ${layer.alpha * 0.5 * hueShift})`);
        g.addColorStop(1, 'rgba(110, 80, 255, 0)');
        ctx.fillStyle = g;
        ctx.fill();
      }

      // ── コア ──
      const core = ctx.createRadialGradient(
        cx - R * 0.15,
        cy - R * 0.18,
        R * 0.05,
        cx,
        cy,
        R
      );
      core.addColorStop(0, `rgba(255, 255, 255, ${(0.95 - (isError ? 0.5 : 0)) * 1})`);
      core.addColorStop(0.35, `rgba(${isError ? '150,170,190' : '175, 240, 255'}, 0.9)`);
      core.addColorStop(0.75, `rgba(${isError ? '90,100,120' : '70, 150, 250'}, 0.55)`);
      core.addColorStop(1, `rgba(${isError ? '50,55,70' : '80, 70, 220'}, 0.12)`);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      // ── 縁のハイライト（球としての立体感）──
      ctx.strokeStyle = `rgba(200, 245, 255, ${(0.25 + lv * 0.45) * hueShift})`;
      ctx.lineWidth = Math.max(1, R * 0.015);
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.98, 0, Math.PI * 2);
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full" />
      {state.visualState === 'error' && (
        <span className="absolute inset-x-0 bottom-0 text-center text-[10px] font-medium text-red-200">
          ⚠ 音声ソース切断
        </span>
      )}
    </div>
  );
}
