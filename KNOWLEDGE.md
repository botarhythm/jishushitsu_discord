# KNOWLEDGE.md — プロジェクト横断ステータス

> 複数AI（Claude Code / Antigravity / その他）が共有するプロジェクトの現状・決定事項の単一ソース。
> Claude の private メモリと常に同期される（Skill: project-knowledge-sync）。

Last synced: 2026-08-20

## 運用フェーズ (Ocean)

- 現在: **F1**（ユーザー宣言があるまでの暫定。逼迫時は F2 へ）

## 製品・プロジェクト状況

### [project-jishushitsu] デジタル原っぱ大学 自習室
- LiveKit ベースのオンライン学習 WebRTC アプリ（Next.js 16 / Vercel）。本番: session.botarhythm.com
- 正本リポジトリ: botarhythm/jishushitsu_discord（origin/main 一本）

### [project-ai-participant] AI参加者収録機能（進行中）
- 収録モードを「人間2名 + ChatGPTデスクトップ音声」の3者ビデオポッドキャスト収録に拡張。
  OpenAI API 不使用 — VB-CABLE 経由の外部音声参加者として取り込む
- 状態: **PR #8。ホスト+AI の2者は実機検証済み（2026-08-20）**
  - 録画に「自分の声 + ChatGPT の声」が入ることを確認
  - ChatGPT がこちらの声に応答することを確認
  - 中央下部のエネルギー球が発話で揺らぐことを確認
  - 未検証: リモート参加者を加えた3者（人間2+AI）での収録
- 実装前レビュー: Codex gpt-5.6-sol 2巡・条件付きGO → `docs/reviews/ai-participant-codex-review-2026-08-20.md`
- 既存保護: AI無効時は既存挙動と完全同一（フィーチャーフラグ）
- 残タスク: ①VB-CABLE実機でプリフライト4試験 ②既存2者収録の回帰確認 ③本番LiveKitで
  Track.Source.Unknown の publish/subscribe/reconnect 試験
- 別タスク起票: (a) IndexedDB逐次チャンク永続化+クラッシュ復旧（最優先） (b) broadcast-studio 送信者認証
- テスト用: セットアップUIの音声ソース deviceId に `fake` を指定すると 880Hz Oscillator の
  FakeProvider になる（ChatGPT/CABLE 不要で結合検証可）

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
- AI参加者セットアップ手順: `docs/ai-participant-setup.md`

---
### 変更履歴
- 2026-08-20: 初版作成。AI参加者収録機能（PR #8）の状況を記載
