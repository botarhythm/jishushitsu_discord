# EchoNote 連携（廃止・2026-10-10）

自習室から EchoNote へ録音を送り、文字起こし・要約する連携は**廃止した**。

- 理由: 自習室はデジハラの道具（ポッドキャスト収録＋会期中のオンライン学習）、EchoNote はボタリズムのコーチング専用として、別の製品に分けた。デジハラの録音はタブ録画のローカル保存で足りている。
- 撤去したもの: `app/api/echonote/*`・`lib/echonote.ts`・`lib/audio-recorder.ts`・`hooks/useSessionRecorder.ts`・`hooks/useChunkUpload.ts`・終了モーダルの「要約を生成」・講師の音声録音ボタン、`/api/invite-token` の `X-Service-Secret`（サーバー間で講師リンクを発行する入口）。
- 使わなくなった環境変数: `SERVICE_SHARED_SECRET`・`INSTRUCTOR_<N>_DISCORD_ID`・`INSTRUCTOR_<N>_ECHONOTE_URL`・`INSTRUCTOR_<N>_ECHONOTE_TOKEN`。本番（Vercel）からの削除は店主が行う。
- EchoNote 側の対になる変数とランチャー UI の撤去は、EchoNote 側のタスク（T-20261010-01）で行う。
- 経緯: Hub `tasks/T-20261010-02_jishushitsu-gap-fixes.md`。旧仕様は git の履歴を参照。
