/**
 * room metadata の `studio` から「ほかの人が収録モードで録画中か」を読む。
 *
 * /api/broadcast-studio が `studio.recording` を書く。受講生・ゲストは入室直後に
 * これを見て、録画中ならマイクを OFF のまま入室する。
 * 自分がホストの studio は対象外 (自分の録画で自分のマイクを止めない)。
 * metadata が無い・壊れている・古いクライアントが書いた (recording が無い) 場合は
 * 「録画中ではない」とみなし、従来どおりマイクを入れる。
 */
export function isStudioRecordingFor(
  roomMetadata: string | undefined | null,
  selfIdentity: string
): boolean {
  if (!roomMetadata) return false;
  try {
    const parsed = JSON.parse(roomMetadata) as {
      studio?: { active?: unknown; recording?: unknown; host?: unknown } | null;
    };
    const studio = parsed?.studio;
    return !!studio && studio.active === true && studio.recording === true && studio.host !== selfIdentity;
  } catch {
    return false;
  }
}
