# EchoNote 連携

自習室で行ったセッションの音声を、自動で **EchoNote** に送信し、文字起こしと AI 要約を生成する機能です。

## できること

- 講師が自習室に入室すると、自動で全員の音声録音が開始されます（録音中インジケーター表示）
- **メインルーム / ブレイクアウト1 / 2 / 3 はそれぞれ別ファイルとして録音** されます
  - 例: メインで講義 → BO1で個別指導 → メインに戻って総括、というセッションだと 3 ファイルが生成されます
  - EchoNote 側でも別セッションとして要約されるので、内容ごとに整理されます
- 「セッション終了」ボタンで Zoom 風モーダルが表示され、以下から選べます:
  - **全員終了 + 要約を生成**: 受講生も全員退出させ、録音を EchoNote へ送信。後で要約付きで結果を確認できます
  - **自分だけ退出**: 受講生は自習室に残り、講師のみ退出
- 講師ごとに **別々の EchoNote インスタンス** に送信可能（マルチテナント対応）

## アーキテクチャ

```
[講師ブラウザ]
  ├─ 録音 (Web Audio API + MediaRecorder)
  └─ 全員退出シグナル送信
        │
        ▼
[digihara サーバー]
  ├─ /api/end-session       (LiveKit にデータチャンネル経由でブロードキャスト)
  └─ /api/echonote/upload   (講師キーから送信先を解決し、EchoNote /api/ingest へプロキシ)
        │
        ▼
[講師個人の EchoNote]
  └─ /api/ingest            (Bearer 認証 → Drive アップロード → 文字起こし → 要約)
```

## 講師ごとの設定（マルチテナント）

各講師は自分専用の EchoNote インスタンスを持てます。`.env.local` に対応する変数を設定してください:

```env
# 元沢 講師の EchoNote
ECHONOTE_URL_MOTOZAWA=https://echonote-mocchan.up.railway.app
ECHONOTE_TOKEN_MOTOZAWA=...

# 塚越 講師の EchoNote
ECHONOTE_URL_TSUKAKOSHI=https://echonote-tsukakoshi.up.railway.app
ECHONOTE_TOKEN_TSUKAKOSHI=...
```

設定が無い講師がセッションを終了しようとすると、「全員終了」モーダルで EchoNote 未設定の旨が警告として表示され、要約は生成されず退出のみが行われます。

## EchoNote インスタンスの作り方

各講師は以下の手順で自分の EchoNote をデプロイできます:

1. https://github.com/botarhythm/EchoNote を **Fork**
2. Railway / Vercel などにデプロイ
3. 必要な環境変数を設定（`GEMINI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_SERVICE_ACCOUNT_KEY` / `DRIVE_FOLDER_ID` / `DATABASE_URL` / `ECHONOTE_INGEST_TOKEN` 等）
4. 詳しい手順は EchoNote リポジトリの README を参照

## ingest token の取得

EchoNote 側で以下のように生成し、その値を digihara の `ECHONOTE_TOKEN_<INSTRUCTOR>` に設定します:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

EchoNote 側の `.env.local` には同じ値を `ECHONOTE_INGEST_TOKEN=` として設定してください。

## 録音について

- 録音方式: ブラウザの **MediaRecorder API**（Web Audio API で全参加者の音声をミックス）
- 形式: webm/opus（Gemini が認識可能で軽量）
- データの流れ: 講師ブラウザのメモリ上に蓄積 → 終了時に digihara 経由で EchoNote へ転送
- **注意**: 講師がブラウザタブを閉じると録音が失われます。タブを閉じる前にブラウザの警告が出ます
- 想定セッション長: 1〜2 時間（3 時間を超える場合はブラウザによっては不安定になる可能性があります）
- **動画は録画されません**（音声のみ）。動画記録が必要な場合は OBS 等の外部ソフトを併用してください

## 録音されるルーム

| ルーム | 録音 | EchoNoteでの memo |
|---|---|---|
| メインルーム | される | `メイン` |
| ブレイクアウト 1 | される | `BO1` |
| ブレイクアウト 2 | される | `BO2` |
| ブレイクアウト 3 | される | `BO3` |

ファイル名の例: `20260506_自習室_メイン.webm` / `20260506_自習室_BO1.webm`

ルーム間を移動すると現在の録音が自動で確定保存され、移動先で新しい録音が始まります。同じセッションで複数の録音ファイルが作られ、終了時にまとめて EchoNote へ送信されます。

## 既知の制限

- 録音は講師のブラウザで行われるため、講師がブラウザを閉じると録音が失われます
- 同時接続数や音質は LiveKit の制約に従います
- ルーム間移動の瞬間（数百ms）の音声は録音から漏れる可能性があります

## 将来の拡張候補

- LiveKit Cloud の **Egress** によるサーバー側録音への切り替え（タブを閉じても録音継続・動画録画も可能）
- 自習室セッションとEchoNote側のクライアント名の自動紐付け
- リアルタイム文字起こし（録音と並行）
