# KNOWLEDGE.md — プロジェクト横断ステータス

> 複数AI（Claude Code / Antigravity / その他）が共有するプロジェクトの現状・決定事項の単一ソース。
> Claude の private メモリと常に同期される（Skill: project-knowledge-sync）。

Last synced: 2026-08-21

## 運用フェーズ (Ocean)

- 現在: **F1**（ユーザー宣言があるまでの暫定。逼迫時は F2 へ）

## 製品・プロジェクト状況

### [project-jishushitsu] デジタル原っぱ大学 自習室
- LiveKit ベースのオンライン学習 WebRTC アプリ（Next.js 16 / Vercel）。本番: session.botarhythm.com
- 正本リポジトリ: botarhythm/jishushitsu_discord（origin/main 一本）

### [project-ai-participant] AI参加者収録機能（本番稼働中）
- 収録モードを「人間2名 + ChatGPTデスクトップ音声」の3者ビデオポッドキャスト収録に拡張。
  OpenAI API 不使用 — VB-CABLE 経由の外部音声参加者として取り込む
- 状態: **PR #8・#9 ともマージ済み。本番 session.botarhythm.com で稼働中（2026-08-20）**
  - 録画に「自分の声 + ChatGPT の声」が入ることを確認
  - ChatGPT がこちらの声に応答することを確認
  - 中央下部のエネルギー球が発話で揺らぐことを確認
  - **リモート参加者の声が ChatGPT に届くことを検証済み**（VoiceMeeter の物理マイク
    ストリップを M でミュートし、直通路を切った状態でシークレットウィンドウから
    話しかけて ChatGPT が応答することを確認。本番と同一の経路）
  - 既知の課題: 同一PC上で2ブラウザ+録画+VoiceMeeter を同時に動かすと音声が途切れる
    （負荷由来と推定。ホスト+AIのみの収録では発生していない）
- 実装前レビュー: Codex gpt-5.6-sol 2巡・条件付きGO → `docs/reviews/ai-participant-codex-review-2026-08-20.md`
- 既存保護: AI無効時は既存挙動と完全同一（フィーチャーフラグ）
- 残タスク: ①VB-CABLE実機でプリフライト4試験 ②既存2者収録の回帰確認 ③本番LiveKitで
  Track.Source.Unknown の publish/subscribe/reconnect 試験
- 別タスク起票: (a) IndexedDB逐次チャンク永続化+クラッシュ復旧（最優先） (b) broadcast-studio 送信者認証
- テスト用: セットアップUIの音声ソース deviceId に `fake` を指定すると 880Hz Oscillator の
  FakeProvider になる（ChatGPT/CABLE 不要で結合検証可）
- 2026-08-21: 設定モーダル最上部に「この PC ではこう設定します」を追加（`lib/ai-wiring-plan.ts`）。
  **現在の選択から逆算せず、列挙デバイスだけから正解を計算する**のが要点 — 逆算方式は
  選択が誤っているときに誤った OS 設定を案内していた。アプリ内3箇所はワンクリック適用可

### [project-chatgpt-audio-recovery] ChatGPT が音声を認識しないときの復旧（2026-08-21）
- 症状は再発する。**目視で設定を追わず `scripts/check-chatgpt-audio.ps1` で実測する**
  ```powershell
  pwsh -File scripts/check-chatgpt-audio.ps1        # 診断
  pwsh -File scripts/check-chatgpt-audio.ps1 -Fix   # VoiceMeeter 側を自動復旧
  ```
- 判定の原理: **B1 バスのピーク dB を実測**する（= ChatGPT が実際に聞いている音）。
  音が乗っていれば配線は正常＝原因は ChatGPT アプリ側。無音なら配線が切れている
- 再発原因（実機で観測した順）
  1. **イヤホン接続で VoiceMeeter の IN1 が別デバイスへ変わる／開けなくなる**（最頻）。
     2026-08-21 は IN1 が soundcore P40i になっていた。VoiceMeeter は開けないデバイス名を
     **赤文字**で表示する（正常な割当は淡色）
  2. 設定するアプリの取り違え。**この開発 PC では `ChatGPT` = Codex、音声対話は
     `ChatGPT Classic`。両方起動しているのが正常**で終了させる必要はない。
     音量ミキサーで出力デバイスを設定するのは音声対話に使っている方の行
     （スクリプトの既定は `-VoiceApp 'ChatGPT Classic'`）
  3. 録音の「既定の通信デバイス」が `Voicemeeter Out B1` から外れる（ここが ChatGPT の耳）
- 実装: CoreAudio COM で既定4枠を取得 + VoicemeeterRemote64.dll の Remote API で
  IN1 デバイス名 / A・B / MUTE を実値取得 + `VBVMR_GetLevel` でレベル実測

### [project-recording-pipeline] 収録→Canva→Spotify パイプライン
- アプリ側の WebM Duration/Cues 注入は修正済み（c709e0f）。Canva 出力の長さ不一致は
  ffmpeg 完全再エンコードで修復（Spotify 受理実証済み）

## 決定事項 / 方針

- [project-jishushitsu-echonote-decouple] EchoNote とは別プロダクトとして独立開発。資産流用はするが結合しない
- [feedback-nextjs16] Next.js 16 は破壊的変更が多い — コードを書く前に `node_modules/next/dist/docs/` を読む
- 収録アーキテクチャ: 録画は「自タブ Region Capture + AudioContext ミキシング」方式を維持。
  Recorder は参加者を知らない（AudioTrackRegistry 経由）。AI 判定はトラック単位 RMS のみ

## インフラ / デプロイ

### ローカル開発環境の注意（この開発PC固有）

- **ポート 3000 はバインド不可**（`EACCES`。netsh の excludedportrange には現れないが
  実際に listen できない）。README が記載する `localhost:3000` は使えないため、
  開発サーバーは **3100** で起動する（`.claude/launch.json` の dev 設定）。
- そのため Discord Developer Portal の OAuth2 → Redirects に
  `http://localhost:3100/api/auth/discord/callback` の登録が必要。
  未登録だとログイン時に「OAuth2 redirect_uri が無効です」で止まる。

- [project-vercel-team] Vercel: botarhythms-projects 所有。main マージも自分で実行可。PR で Preview デプロイ
- [project-safebrowsing-falsepositive] Safe Browsing 警告は false positive（対策として独自ドメイン session.botarhythm.com へ移行済み）

## 外部参照

- [reference-github] https://github.com/botarhythm/jishushitsu_discord （塚ちゃんの PR は fork 経由）
- [reference-echonote] EchoNote: `~/Documents/gemini/EchoNote`、Railway ホスティング
- AI参加者の要件定義: `~/Downloads/jishushitsu_discord_A2A_requirements.md`
- AI参加者セットアップ手順: `docs/ai-participant-setup.md` / アプリ内 `/help/ai-participant`（スクショ入り正本）
- ChatGPT音声の診断・復旧: `scripts/check-chatgpt-audio.ps1`

---
### 変更履歴
- 2026-08-20: 初版作成。AI参加者収録機能（PR #8）の状況を記載
- 2026-08-21: ChatGPT音声が認識されないときの復旧手順を追加（scripts/check-chatgpt-audio.ps1）。AI参加者機能をマージ済み・本番稼働中に更新
- 2026-08-21: ChatGPT系アプリの役割を訂正（ChatGPT=Codex / ChatGPT Classic=音声対話。両方起動が正常）
