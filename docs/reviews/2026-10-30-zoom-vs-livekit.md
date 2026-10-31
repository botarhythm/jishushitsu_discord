# Zoom と自習室（LiveKit）の差 — 2026-10-30

## 前提

10/29 朝、店主のメインのノート PC（もっちゃん）から自習室に入ると、上りの送信だけが細り、通話が成り立たなかった。
同じ PC・同じ回線・同じ時刻に、Zoom は使えた（店主の確認）。
店主の結論：**この PC の通信状況に耐えられないのは、自習室アプリの側の弱さ**。
この文書は、その結論に立って、Zoom にあって自習室にないものを洗い出す。
（10/29 の調査記録 `2026-10-29-livekit-session-analysis.md` は「アプリの問題ではない」と書いており、この見方と食い違う。）

## Zoom の仕組み（資料で確かめたこと）

| 項目 | 内容 | 出典 |
|---|---|---|
| 経路の選び方 | 実際のネットワークの状態とポリシーから最良の経路を選ぶ層を持つ。UDP を使い、使えなければ TCP/TLS（HTTPS/443 を含む）へ切り替える | Zoom BCDR ホワイトペーパー（Zoom 公式、独語） |
| 品質の監視 | 帯域・パケットロス・遅延・ジッターを監視し、上位の層に適応させる | 同上 |
| 劣化への適応 | フレームレートと解像度を継続的に調整する。複数の層を同時に送り、受け手が最適な層を選ぶ。パケットロス約 45% まで使える。その場合は音声を映像より優先する | 同上 |
| 2 人のとき | 参加者が 2 人なら、サーバーを通さず 2 台を直接つなぐ（P2P）。3 人目が入るとサーバー経由に切り替わる | ICPE 2023（カルガリー大）、Zoom 公式 |
| 回復の仕組み | 誤り訂正（FEC）、アプリ層での再送、接続の張り直しを持つ。帯域を積極的に探り、映像のビットレートを合わせる | ICPE 2023 |
| 通り道 | サーバー経由のとき、音声・映像・画面共有をそれぞれ別の UDP ポートで送る | ICPE 2023 |

資料で確かめられなかったこと：
- 使えている UDP が「遅い・細い」だけのときに、通話中に TCP/TLS へ切り替えるか。切り替えの判断の時間（何秒で切り替えるか）。
- 10/29 朝の Zoom が P2P だったか、どの経路（UDP/TCP）だったか。店主の Zoom も 2 人だったなら、P2P の可能性がある。

## LiveKit（自習室）の仕組み（SDK 2.18.9 のコードと公式資料で確かめたこと）

| 項目 | 内容 | 根拠 |
|---|---|---|
| 経路の選び方 | 接続時に ICE で UDP・TCP（7881）・TURN/UDP・TURN/TLS（443）を試し、通った経路を使う。TURN/TLS は「UDP 接続が成り立たないとき」に使う | LiveKit 公式「Configuring firewalls」 |
| 通話中の切り替え | WebRTC の接続が `failed` になる、またはサーバーへの ping が時間切れになったときだけ、再接続する。**経路が遅い・細いだけでは切り替えない**。品質を見て経路を変える仕組みはない | `livekit-client.esm.mjs` の `pcManager.onStateChange`（`FAILED` のときだけ `handleDisconnect`）、`DefaultReconnectPolicy` |
| 再接続の既定値 | WebRTC の接続待ち 15 秒、WebSocket の接続待ち 15 秒、接続時の再試行 1 回 | `roomConnectOptionDefaults` |
| 自分の接続品質 | サーバーが判定した自分の接続品質を `ConnectionQualityChanged` で通知する（10/29 朝は 3.42 → 1.25 に低下していた） | `onLocalConnectionQualityChanged` |
| 2 人のとき | 常に LiveKit Cloud のサーバー（SFU）経由。直接つなぐ仕組みはない | LiveKit の構成 |
| 劣化への適応 | WebRTC の帯域推定で映像を絞る。simulcast・adaptiveStream・dynacast がある。音声は RED（冗長送信）で欠落を補う | `lib/call-media-options.ts` |

## 自習室の今の設定と、10/29 朝の実測

- 音声：モノラル・speech（上限 24 kbps）・RED あり・DTX なし。実際の送信は約 50 kbps。
- 映像：540p・20 fps・主レイヤー上限 700 kbps、simulcast で 180p・360p も同時に送る。実際の送信は合計 1.2〜1.4 Mbps（10/26 の もっちゃん の中央値 1.35 Mbps）。映像の優先度は low。
- 10/29 朝の もっちゃん：送信カメラ 3〜12 kbps、マイク 1.5〜9 kbps、パケットロス 0%、品質 3.42 → 1.25、往復遅延 p99 460 ms。サーバーの判断で `CONNECTION_TIMEOUT`（ping の時間切れ）になるまで、経路は UDP のままだった。
- 10/29 に入れた自動切り替え（`lib/uplink-watchdog.ts`）は、「受信の報告が 8 秒まったく戻らない」ときだけ動く。朝は細く届き続けていたので、**動かなかった可能性が高い**（未検証）。

## 自習室に足りないもの（優先度順）

| # | 足りないもの | Zoom | 自習室 | 打てる手 |
|---|---|---|---|---|
| 1 | 経路の品質を見て切り替える | 品質を監視し、UDP から TCP/TLS へ切り替える | 接続が `failed` になるまで切り替えない。10/29 に入れた見張りも、完全に止まったときしか動かない | 自分の接続品質（`ConnectionQualityChanged` の Poor/Lost）、往復遅延、送信量の落ち込みで判定し、TLS へ切り替える。10/29 朝・10/21・10/26 の記録の数値に当てはめて、動くことを確かめる |
| 2 | 劣化したら音声を守る | 映像を落として音声を優先する | 映像の優先度は low だが、送信量そのものは自動で大きくは減らない（朝は映像も音声も一緒に止まった） | 品質が落ちたら、自分の映像の送信を一時的に止める（または最低の層だけにする）。本人に知らせ、回復したら戻す |
| 3 | 送信の総量 | 層の数と送る量を、状況に合わせて決める（数値は資料にない） | 常に 3 層・合計約 1.3 Mbps を送る | 2〜4 人の部屋なら、上の層（540p）を送らない・上限を下げる、を検討する。弱い Wi-Fi で詰まりにくくなる。画質とのかね合いは実測で決める |
| 4 | 一度不調だった PC は、最初から通りやすい経路で | 資料なし | 毎回 UDP から試す | 自動切り替えが起きた端末は、次回から TLS で入る（その端末にだけ記録） |
| 5 | 2 人のときの直接接続 | P2P で、サーバーまでの経路を通らない | 常にサーバー経由 | LiveKit Cloud では選べない。対応しない（参考） |

差がないもの：欠落の補い（Zoom の FEC・再送に対し、WebRTC は映像の再送（NACK/RTX）と音声の RED を持つ）。

## 実装（10/30）

1〜4 を入れた。中身・閾値の根拠・検証結果は `2026-10-29-livekit-session-analysis.md` の「劣化への備え（10/30 実装）」。
品質の閾値は LiveKit サーバーのコードで確かめた（Poor＝ダッシュボードの品質スコア 2.06 以下、Lost＝1.25 以下）。

## 未確認

- 10/29 朝の Zoom の経路（P2P か、UDP/TCP のどちらか）。次に同じ状況になったら、Zoom の「統計情報」画面で確かめられる。
- TLS へ切り替えれば、実際の「細く届く」不良が直るか。
- 映像を止めれば音声が届くようになるか（朝は音声も 1.5〜9 kbps まで落ちていた。経路そのものが詰まっていた可能性もある）。

## 出典

- Zoom BCDR ホワイトペーパー：https://library.zoom.com/technical-library/de/administrationsbereich/architecture-and-design/bcdr-whitepaper.md
- Karamollahi, Williamson, Arlitt「Packet-Level Analysis of Zoom Performance Anomalies」ICPE 2023：https://cspages.ucalgary.ca/~cwill/papers/2023/Mehdi-ICPE2023.pdf
- LiveKit「Configuring firewalls」：https://docs.livekit.io/deploy/admin/firewall/
- livekit-client 2.18.9（`node_modules/livekit-client/dist/livekit-client.esm.mjs`）
