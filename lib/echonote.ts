/**
 * 講師ごとの EchoNote 接続情報を環境変数から取得する。
 *
 * 環境変数の命名規則:
 *   ECHONOTE_URL_<INSTRUCTOR>      送信先 EchoNote のベースURL
 *   ECHONOTE_TOKEN_<INSTRUCTOR>    その EchoNote の ingest token
 *
 * 例:
 *   ECHONOTE_URL_MOTOZAWA=https://echonote-mocchan.up.railway.app
 *   ECHONOTE_TOKEN_MOTOZAWA=...
 *   ECHONOTE_URL_TSUKAKOSHI=https://echonote-tsukakoshi.up.railway.app
 *   ECHONOTE_TOKEN_TSUKAKOSHI=...
 *
 * 講師の判定は INSTRUCTOR_KEY_<NAME> と一致する instructorKey から行う。
 * 各講師は自分専用の EchoNote インスタンスを持てる（マルチテナント）。
 */

interface EchoNoteEndpoint {
  url: string;
  token: string;
  instructorName: string;
}

interface InstructorConfig {
  envSuffix: string;        // 例: 'MOTOZAWA' / 'TSUKAKOSHI'
  displayName: string;      // 例: '元沢信昭'
}

// 既知の講師リスト。新しい講師を追加する場合はここに行を足し、対応する env を定義する。
const INSTRUCTORS: InstructorConfig[] = [
  { envSuffix: 'MOTOZAWA', displayName: '元沢信昭' },
  { envSuffix: 'TSUKAKOSHI', displayName: '塚越暁' },
];

/**
 * instructorKey から該当講師を見つけ、その EchoNote 設定を返す。
 * key 不一致なら null。env 未設定（EchoNote未使用の講師）の場合も null。
 */
export function resolveEchoNoteEndpoint(instructorKey: string): EchoNoteEndpoint | null {
  if (!instructorKey) return null;

  for (const inst of INSTRUCTORS) {
    const expected = process.env[`INSTRUCTOR_KEY_${inst.envSuffix}`];
    if (!expected || expected !== instructorKey) continue;

    const url = process.env[`ECHONOTE_URL_${inst.envSuffix}`];
    const token = process.env[`ECHONOTE_TOKEN_${inst.envSuffix}`];
    if (!url || !token) return null; // この講師は EchoNote 未設定

    return { url, token, instructorName: inst.displayName };
  }
  return null;
}

/**
 * 講師の EchoNote が設定されているかだけを判定する（クライアントへの状態提示用）。
 */
export function hasEchoNoteConfig(instructorKey: string): boolean {
  return resolveEchoNoteEndpoint(instructorKey) !== null;
}
