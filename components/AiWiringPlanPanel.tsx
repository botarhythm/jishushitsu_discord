'use client';

import { matchesPlan, type WiringPlan } from '@/lib/ai-wiring-plan';

export type PlanTarget = 'source' | 'mic' | 'sink';

interface Props {
  plan: WiringPlan;
  currentSourceId: string | null;
  currentMicId: string | null;
  currentSinkId: string | null;
  onApply: (target: PlanTarget) => void;
  onApplyAll: () => void;
  busy: boolean;
}

/**
 * 「この PC ではこう設定する」を、設定を始める前に提示する早見表。
 *
 * 従来この画面は「間違えたら赤い警告を出す」方式だった。だが正解を知らない
 * 利用者にとっては、警告が出てはじめて選び直す＝毎回やり直しになる。
 * 接続されているデバイスから正解は機械的に決まるので、先に全部名指しし、
 * アプリ内で設定できる3つはワンクリックで合わせられるようにする。
 *
 * Windows 側の2つはブラウザからは変更できないため、名指しの表示に留める。
 */
export function AiWiringPlanPanel({
  plan,
  currentSourceId,
  currentMicId,
  currentSinkId,
  onApply,
  onApplyAll,
  busy,
}: Props) {
  if (plan.mode === 'unknown') {
    return (
      <div className="mb-4 rounded-xl border border-amber-800/60 bg-amber-950/30 p-3">
        <p className="text-xs font-medium text-amber-200">仮想ケーブルが見つかりません</p>
        <p className="mt-1 text-pretty text-xs leading-relaxed text-amber-100/80">
          VB-CABLE がインストールされていないか、ブラウザにデバイス名を読む権限がありません。
          先に VB-CABLE を入れて PC を再起動してください。
        </p>
      </div>
    );
  }

  const appRows: { key: PlanTarget; label: string; value: string; matched: boolean }[] = [
    {
      key: 'source',
      label: '① AI 音声ソース',
      value: plan.source?.label ?? '—',
      matched: matchesPlan(currentSourceId, plan.source),
    },
    {
      key: 'mic',
      label: '通話マイク',
      value: plan.mic?.label ?? '—',
      matched: matchesPlan(currentMicId, plan.mic),
    },
    {
      key: 'sink',
      label: '② ChatGPT への送出先',
      value: plan.sink?.label ?? '使用しない',
      matched: matchesPlan(currentSinkId, plan.sink),
    },
  ];

  const osRows: { where: string; value: string | null; note?: string }[] = [
    {
      where: '音量ミキサー → ChatGPT の「出力デバイス」',
      value: plan.chatgptOutput?.label ?? null,
      note: '似た名前の別デバイスに注意（CABLE In 16ch など）',
    },
    {
      where: 'mmsys.cpl → 録音タブ →「既定の通信デバイス」',
      value: plan.chatgptInput?.label ?? null,
      note: 'ChatGPT はここを「耳」として使う',
    },
  ];

  const mismatched = appRows.filter((r) => !r.matched);

  return (
    <div className="mb-4 rounded-xl border border-sky-800/60 bg-sky-950/30 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-medium text-sky-200">この PC ではこう設定します</p>
        <p className="text-xs text-stone-400">構成: {plan.modeLabel}</p>
      </div>

      <p className="mb-1.5 text-xs text-stone-400">アプリ内（この画面で設定します）</p>
      <ul className="space-y-1.5">
        {appRows.map((r) => (
          <li key={r.key} className="text-xs">
            <p className="text-stone-400">{r.label}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <code className="rounded bg-stone-800 px-1.5 py-0.5 text-sky-200">{r.value}</code>
              {r.matched ? (
                <span className="text-emerald-400">✓ 一致</span>
              ) : (
                <>
                  <span className="text-amber-300">要変更</span>
                  <button
                    type="button"
                    onClick={() => onApply(r.key)}
                    disabled={busy}
                    className="rounded border border-amber-700 px-2 py-0.5 text-xs font-medium text-amber-200 hover:bg-amber-900/40 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    これにする
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {mismatched.length > 0 && (
        <button
          type="button"
          onClick={onApplyAll}
          disabled={busy}
          className="mt-2.5 rounded-lg bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          推奨をまとめて適用（{mismatched.length} 件）
        </button>
      )}

      <p className="mb-1.5 mt-3 text-xs text-stone-400">
        Windows 側（アプリからは変更できません）
      </p>
      <ul className="space-y-1.5">
        {osRows.map((r) => (
          <li key={r.where} className="text-xs leading-relaxed">
            <span className="text-stone-400">{r.where}</span>
            <span className="text-stone-400"> → </span>
            {r.value ? (
              <code className="rounded bg-stone-800 px-1.5 py-0.5 text-sky-200">{r.value}</code>
            ) : (
              <span className="text-stone-400">（この構成では不要）</span>
            )}
            {r.note && <p className="ml-2 text-stone-400">※ {r.note}</p>}
          </li>
        ))}
      </ul>

      <p className="mt-2 text-pretty text-xs leading-relaxed text-stone-300">
        ChatGPT を再起動すると出力デバイスが戻ることがあります。
        認識しなくなったら、まず Windows 側のこの2つを見比べてください。
      </p>
    </div>
  );
}
