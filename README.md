# デジタル原っぱ大学 自習室

オンライン学習支援 WebRTC アプリです。LiveKit Cloud + Next.js で構築しており、ブレイクアウトルーム・挙手通知・強制移動機能を備えています。

## 機能概要

| 機能 | 説明 |
|------|------|
| メインルーム | 全員が集まる広場。最大20名の画面共有を一覧表示 |
| ブレイクアウトルーム | 1対1指導用の個室（BO1〜BO3の3部屋） |
| 挙手機能 | 受講生が質問を講師に通知するボタン |
| 強制移動 | 講師がボタン操作で受講生をBOへ自動移動 |
| 聴講参加 | 進行中のBOに任意で参加・離脱できる |

## 技術スタック

| 層 | 技術 |
|----|------|
| フロントエンド | Next.js 16 (App Router) + TypeScript |
| UI | Tailwind CSS v4 |
| WebRTC クライアント | LiveKit Client SDK + @livekit/components-react |
| バックエンド API | Next.js API Routes |
| WebRTC SFU | LiveKit Cloud |
| ホスティング | Vercel（推奨） |

## ディレクトリ構成

```
jishushitsu/
├── app/
│   ├── page.tsx              # ランディングページ
│   ├── room/page.tsx         # ルームページ
│   ├── layout.tsx            # 共通レイアウト（フォント設定）
│   └── api/
│       ├── token/route.ts    # LiveKitトークン発行API
│       └── move-participant/ # 強制移動API
│           └── route.ts
├── components/
│   ├── LandingContent.tsx    # 名前入力フォーム
│   ├── RoomView.tsx          # ルーム全体（参加者グリッド・コントロール）
│   └── InstructorDashboard.tsx # 講師専用サイドパネル
├── lib/
│   └── types.ts              # 型定義
├── docs/
│   ├── admin-manual.md       # 管理者（講師）向けマニュアル
│   └── participant-manual.md # 参加者向けマニュアル
├── .env.local                # 環境変数（Gitに含めない）
├── .env.local.example        # 環境変数のサンプル
└── README.md
```

## セットアップ

### 前提条件

- Node.js 18 以上
- LiveKit Cloud アカウント（[cloud.livekit.io](https://cloud.livekit.io/)）

### インストール

```bash
# 1. 依存パッケージのインストール
npm install

# 2. 環境変数ファイルを作成
cp .env.local.example .env.local

# 3. .env.local を編集して以下を設定
#   LIVEKIT_API_KEY=<LiveKit CloudのAPIキー>
#   LIVEKIT_API_SECRET=<LiveKit CloudのAPIシークレット>
#   LIVEKIT_URL=wss://<project>.livekit.cloud
#   INSTRUCTOR_KEY_MOTOZAWA=<32文字以上のランダム文字列>
#   INSTRUCTOR_KEY_TSUKAKOSHI=<32文字以上のランダム文字列>

# 講師キーの生成コマンド（2回実行して各講師に設定）
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. 開発サーバーを起動
npm run dev
```

`http://localhost:3000` でアクセスできます。

### 環境変数一覧

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `LIVEKIT_API_KEY` | LiveKit Cloud APIキー | ✅ |
| `LIVEKIT_API_SECRET` | LiveKit Cloud APIシークレット | ✅ |
| `LIVEKIT_URL` | LiveKit Cloud WSS URL（`wss://...`） | ✅ |
| `INSTRUCTOR_KEY_MOTOZAWA` | 元沢信昭 講師の認証キー | ✅ |
| `INSTRUCTOR_KEY_TSUKAKOSHI` | 塚越暁 講師の認証キー | ✅ |

## アクセス URL

| ロール | URL |
|--------|-----|
| 受講生 | `https://<ドメイン>/` |
| 元沢講師 | `https://<ドメイン>/?role=instructor&key=<INSTRUCTOR_KEY_MOTOZAWA>` |
| 塚越講師 | `https://<ドメイン>/?role=instructor&key=<INSTRUCTOR_KEY_TSUKAKOSHI>` |

> **注意**: 講師URLのkeyは`.env.local`に設定した値を使用してください。Discordなどの公開チャンネルに貼らないよう注意してください。

## デプロイ（Vercel）

```bash
# 1. Vercel CLIでデプロイ（または GitHub 連携で自動デプロイ）
npx vercel

# 2. Vercelダッシュボードで環境変数を設定
#    Settings > Environment Variables から上記5つを登録
```

Vercel の `main` ブランチへのプッシュで自動デプロイされます。

## LiveKit Cloud の利用量

| 項目 | 目安 |
|------|------|
| 無料枠 | 5,000分/月 |
| 想定利用 | 週1〜2回 × 2.5時間 × 10名 ≈ 6,000分/月 |
| 想定コスト | 超過分 $0〜10/月 |

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| 接続できない | `.env.local` の LiveKit URL・キーを確認 |
| 画面共有が出ない | Chrome 最新版を使用しているか確認 |
| 講師URLが401エラー | `INSTRUCTOR_KEY_*` が `.env.local` と一致しているか確認 |
| スマホで画面共有できない | 仕様です（聴講のみ対応） |

## 関連ドキュメント

- [管理者（講師）マニュアル](./docs/admin-manual.md)
- [参加者マニュアル](./docs/participant-manual.md)
- [LiveKit 公式ドキュメント](https://docs.livekit.io/)
- [要件定義書](../jishushitsu_requirements.md)
