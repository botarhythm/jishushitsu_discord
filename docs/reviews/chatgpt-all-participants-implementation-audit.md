# ChatGPT 全参加者対話 — 実装監査

- 日付: 2026-09-08
- 監査者: GPT-6 Astra (independent implementation audit)
- 判定: NO-GO

## P1

1. 通常の「参加」は `sourceDeviceId` しか確認せず、配線検証・出力デバイス・現在の通話マイクの条件を迂回する。
2. 接続喪失時に世代を無効化せず、Provider の `disconnected` 通知が `error` を上書きして入力ミキサーが残る／再開する。
3. 非同期接続の停止競合で、遅れて取得したキャプチャが残り、古い cleanup が新しい AI Room を切断し得る。
4. `sessionStorage` の有効化フラグが退出・障害後も残り、役割・現在の検証状態を確認せず再起動する。
5. AI 音声を受信した非オーナーの録画で、タブ再生音と LiveKit リモートトラックが二重に入る。保存済みのホスト向けモニタ設定も全参加者へ適用される。
6. 往復確認後に通話マイクや音源を変えても、その変更後の配線へ検証結果を付与できる。
7. Windows 修復が Core Audio の完全な endpoint ID ではなくレジストリキー名を `SetDefaultEndpoint` に渡す。

## P2

1. ブラウザ一括適用の変更後値を再読込せず合成しており、部分成功の表現と direct-mic 切替が不完全。
2. Windows dry-run と修復で同じ曖昧性確認を行わず、VoiceMeeter readback エラー、無変更時の再起動、修復後の終了判定が不完全。
3. 保存した往復確認時刻・確認レベルの表示、外部変更・device removal による検証失効が不完全。

## 良好だった点

- AI トークン API は講師認証、サーバー由来講師 identity、在室確認、予約 identity の競合拒否、AI の metadata 更新禁止を実装している。
- 旧来の直接 registry／hidden monitor 経路を廃止し、予約 LiveKit 参加者へ寄せる構成は要件の方向と一致する。

## 監査で行った確認

- ソースと diff のレビュー
- 接続途中停止と human reconnect の read-only mock 再現
- Core Audio endpoint ID とレジストリキー名の read-only 比較

実 Windows 修復、実 LiveKit 多人数音声、録画回帰試験は未実施。
