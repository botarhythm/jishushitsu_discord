# T-20260907-01 ChatGPTを通常ルーム参加者として公開

- status: deployed (final Astra gate GO)
- owner: gpt-5.6-sol `/root`
- requirements: FR-001..005, FR-010..012; NFR-001..005

## Deliverables

- 講師・対象ルーム在籍を検証する予約AI参加者トークンAPI。
- `useAiParticipant` の専用LiveKit接続化と停止・競合・切断処理。
- 通常モードの講師操作UI、設定パネル、ChatGPT専用タイル。
- 収録モード往復でもAI有効状態と単一音声経路を維持。

## Verification

- TypeScript、対象eslint、production build。
- 未認証・受講生・未在籍・既存AIのAPI分岐をコード検証。
- AI無効、開始、停止、収録モード往復、切断、置換のライフサイクルをテストまたはブラウザで確認。

## Completion criteria

通常モードで講師がAIを開始・停止・設定でき、予約identityの参加者とAI音声トラックが同じルームの全員へ届き、停止後に残らない。

## Result

- 実装・型検査・対象Lint・production build・Astra競合/lifecycle mockを完了。
- 実複数端末の音声往復と録画再生はデプロイ後の受入確認に残す。
- production: `0c17906` を Vercel へ反映。トップページ 200 と API 未認証 401 を確認。
