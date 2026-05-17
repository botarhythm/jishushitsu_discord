'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAutoLogoutOptions {
  /** 有効化フラグ（受講生のみ true 想定） */
  enabled: boolean;
  /** 入室から最初の警告までの時間(ms)。デフォルト1時間 */
  intervalMs?: number;
  /** 警告から自動退出までの猶予(ms)。デフォルト5分 */
  graceMs?: number;
  /** 猶予内に応答がなかった時に呼ばれる */
  onTimeout: () => void;
}

/**
 * 入室から intervalMs 経過で「自習を継続しますか？」プロンプトを表示し、
 * graceMs 以内に confirmContinue が呼ばれなければ onTimeout を発火する。
 * confirmContinue 後は intervalMs から再カウントされる。
 */
export function useAutoLogout({
  enabled,
  intervalMs = 60 * 60 * 1000,
  graceMs = 5 * 60 * 1000,
  onTimeout,
}: UseAutoLogoutOptions) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [remainingMs, setRemainingMs] = useState(graceMs);

  const intervalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // onTimeout を ref 経由で参照し、ハンドラ更新でタイマーを張り直さない
  const onTimeoutRef = useRef(onTimeout);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  const clearAll = useCallback(() => {
    if (intervalTimerRef.current) {
      clearTimeout(intervalTimerRef.current);
      intervalTimerRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const armInterval = useCallback(() => {
    if (intervalTimerRef.current) clearTimeout(intervalTimerRef.current);
    intervalTimerRef.current = setTimeout(() => {
      const deadline = Date.now() + graceMs;
      setRemainingMs(graceMs);
      setPromptOpen(true);

      tickRef.current = setInterval(() => {
        setRemainingMs(Math.max(0, deadline - Date.now()));
      }, 1000);

      graceTimerRef.current = setTimeout(() => {
        clearAll();
        setPromptOpen(false);
        onTimeoutRef.current();
      }, graceMs);
    }, intervalMs);
  }, [intervalMs, graceMs, clearAll]);

  useEffect(() => {
    if (!enabled) {
      clearAll();
      setPromptOpen(false);
      return;
    }
    armInterval();
    return clearAll;
  }, [enabled, armInterval, clearAll]);

  const confirmContinue = useCallback(() => {
    clearAll();
    setPromptOpen(false);
    setRemainingMs(graceMs);
    if (enabled) armInterval();
  }, [enabled, armInterval, clearAll, graceMs]);

  return { promptOpen, remainingMs, confirmContinue };
}
