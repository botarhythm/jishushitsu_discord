# T-20260907-02 ChatGPT音声設定の一括適用と検証記録

- status: deployed (final Astra gate GO)
- owner: gpt-5.6-sol `/root`
- requirements: FR-006..009; RAC-002, RAC-005, RAC-006

## Deliverables

- リモート往復確認を含む版付き検証記録と旧指紋からの安全な移行。
- ブラウザ設定一括適用の項目別結果、部分成功、再実行。
- Windows修復スクリプトの対象事前解決、VoiceMeeterと既定通信入力の適用後確認。
- ChatGPT Classic内部マイクの残作業と実機確認手順。

## Verification

- 旧記録、設定変更、部分失敗で検証済みに昇格しない。
- dry-runは変更せず計画を表示し、曖昧・欠落では非ゼロ終了。
- 実機のリモートのみ往復確認は利用者が実行し、合格時だけ日時を保存。

## Completion criteria

検証済み構成は1操作で開始でき、未検証構成は明示テスト接続へ進める。自動化不能なChatGPT内部設定を完了扱いにしない。

## Result

- v4検証、競合防止、一括適用、部分結果、Windows診断・修復を実装。
- ChatGPT Classic 内部マイクとリモート往復は画面上で確認を要求し、未確認のまま検証済みにしない。
- production: `0c17906` を Vercel へ反映。セットアップ手順ページ 200 を確認。
