/**
 * Discord User ID をキーに、講師ごとの EchoNote 接続情報を返す。
 *
 * 環境変数命名規則:
 *   INSTRUCTOR_<N>_DISCORD_ID       講師のDiscord User ID (snowflake)
 *   INSTRUCTOR_<N>_ECHONOTE_URL     送信先 EchoNote のベースURL
 *   INSTRUCTOR_<N>_ECHONOTE_TOKEN   その EchoNote の ingest token
 *
 * N は 1 から MAX_INSTRUCTOR_SLOTS まで順番に探索する。
 * EchoNote 未設定 (URL/TOKENが空) の講師は null を返す。
 */

const MAX_INSTRUCTOR_SLOTS = 10;

interface EchoNoteEndpoint {
  url: string;
  token: string;
}

export function resolveEchoNoteEndpointByDiscordId(discordId: string): EchoNoteEndpoint | null {
  if (!discordId) return null;

  for (let i = 1; i <= MAX_INSTRUCTOR_SLOTS; i++) {
    const slotId = process.env[`INSTRUCTOR_${i}_DISCORD_ID`];
    if (!slotId) continue;
    if (slotId !== discordId) continue;

    const url = process.env[`INSTRUCTOR_${i}_ECHONOTE_URL`];
    const token = process.env[`INSTRUCTOR_${i}_ECHONOTE_TOKEN`];
    if (!url || !token) return null;

    return { url, token };
  }
  return null;
}

export function hasEchoNoteConfigForDiscordId(discordId: string): boolean {
  return resolveEchoNoteEndpointByDiscordId(discordId) !== null;
}
