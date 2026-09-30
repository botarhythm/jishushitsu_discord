# 通話の途切れ・音ズレへの改善 — 2026-09-30

## 状態

コード上の改善を実装。型チェック、対象ESLint、本番ビルド、診断テスト15件は成功。
LiveKit Cloudの合成メディア試験は接続と帯域削減を確認したが、受信音声の品質基準を満たさない。
したがって利用者の障害解消を確認したとは扱わない。本番反映・実参加者での受入確認は未実施。

着手時点から存在した通話診断v2等の未コミット変更は保持。本変更とは区別する。

## 実測した障害

Downloadsに保存済みの9月28日通話診断JSONを読み取り確認した。2つのセッションと、後半セッションの重複する保存があるため、3ファイルを3回の独立した障害とは数えない。

- 後半セッションの開始は `2026-09-28T11:44:02.667Z`。開始から約1170秒で、3つの受信音声が同時に受信パケット0・音声補間100%となる区間がある。AI、動画録画、音声録音、収録レイアウトはいずれもfalse。
- 約1174秒でcandidate pairのRTT表示8351ms。その後も受信0〜数十パケットと、蓄積したパケットがまとめて届く区間が交互にある。約1210秒にはRTT表示18899ms・送信帯域推定30000bps、送信音声はその区間だけでも約92kbpsだった。
- 回復時には一部受信バッファ平均が2秒を超える。映像100msの指定だけで、数秒の通信停滞全体を説明することはできない。
- 記録のICE候補はUDP/host。前半セッションにはsignalReconnectingとreconnectingの状態変更もある。

旧schemaVersion 1ではRTTの更新時刻、映像CPU/帯域制限、ブラウザLong Task、OSメモリ状態が不足する。表示RTTが各サンプルで新規測定されたとはいえない。LiveKitとの経路、ブラウザ/OS処理停止、回線混雑のいずれが引き金かは断定できない。音声内容や機器IDは調査資料に転載していない。

## 実装

1. `lib/call-media-options.ts` に会話用設定を集約。人間マイクはモノラル・Opus speech（上限24kbps）。静かな語尾や仮想マイク入力を守るためDTXなし、欠落補完のREDありは維持する。RED等の分だけ実送信量は24kbpsを超える。
2. カメラは最大540p/20fps・主レイヤー上限700kbps。simulcast/adaptiveStream/dynacastを維持し、映像priorityをlowにする。複数レイヤーの合計帯域は700kbpsを超える。マイクpriorityはSDK既定high。画面共有の解像度・fpsは変更しない。
3. 収録ステージの映像 `jitterBufferTarget=100` / `playoutDelayHint=0.1` 指定と重複する定期統計収集を削除。固定値を最大遅延の保証として扱わず、ブラウザのジッター処理と音声・映像同期に任せる。通話診断v2の統計収集は継続する。
4. 接続方式の判断を利用者に求めない。入室画面に追加した接続選択は撤去し、人間・AIともLiveKit SDKの自動経路選択を使う。強制中継は隔離した試験ルーム内の比較にのみ残す。独自の異常検知による経路切替を実装したとは扱わない。
5. AI送信にも同じ低帯域音声設定を使う。音声再生は従来どおりHTML audioで直接再生し、追加AudioContextを直列に挟まない。

注意: 中継指定はTCP/TLS強制ではない。Cloud試験では中継もUDPが選択された。SDKの `simulateScenario('force-tls')` は `@internal for testing` であり、本番の接続切替に流用していない。

## 検証結果

- `npx tsc --noEmit`、対象ESLint、`npm run build`：成功。
- `node --test scripts/verify-call-diagnostics.mjs`：15件成功（着手前から存在するv2を含む）。
- `node scripts/verify-call-transport.mjs --live`：隔離したランダム名のCloudルームのみ作成。実マイク・実カメラ・既存参加者の部屋を使わず、合成音声とCanvas映像を送信。終了時に作成した試験ルームのみ削除する。
- 初回4参加者試験では音声旧96kbps設定の実送信195kbps、新24kbps設定は42kbps。新設定でも受信補間とバッファ増加が残った。帯域減少を障害解消とは扱わない。
- バックグラウンドタイマー等の試験上の制限を外した再試験は、初期signal接続で失敗した。接続成功した試験だけを抽出して成功扱いしない。
- 2参加者・10秒の観測では、自動接続の受信42kbps、補間5.52%、バッファ平均256ms。中継接続の受信42kbps、補間4.33%、バッファ平均415ms。どちらも接続維持と音声パケット到着は確認したが、「補間5%未満かつバッファ300ms未満」の暫定基準を満たさない。
- 合成試験は独立Chromiumを同一PCで動かすため、本物の参加者が別PCで話すときの口元から耳までの遅延や、利用者の主張する音ズレの受入検証を代替しない。
- 数値結果はignoredな `output/playwright/call-transport*.json` に保存。合格しない場合は試験を非ゼロ終了させる。接続失敗でも失敗記録を保存する。

## 残る確認

改善版の公開後、利用者が接続設定を変更しない実参加者の4名通話で、ホストと正常な相手の両方の診断v2を照合する必要がある。症状が残る場合は、新鮮な通信応答の有無、映像帯域/CPU制限、ブラウザLong TaskとOSメモリログを同時刻で比較して次の修正を決める。通信経路の比較は開発側が行い、利用者に専門用語の選択を求めない。音楽品質・カメラ画質の低下も受入対象。

## 根拠

- [W3C WebRTC jitterBufferTarget](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget)：固定targetは最大遅延の保証ではなく、A/V同期にも関係する。
- [LiveKitメディア送信](https://docs.livekit.io/transport/media/publish/)、導入済みSDK 2.18.9の `src/room/track/options.ts`、`defaults.ts`、`participant/LocalParticipant.ts`。
- [LiveKitファイアウォール設定](https://docs.livekit.io/deploy/admin/firewall/)：UDPとTURN/TLS等の接続経路。
