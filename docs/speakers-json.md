# 収録の話者ログ（speakers.json）

録画を停止すると、録画ファイルと同じ名前の `.speakers.json` も保存される。

- 例：`自習室_20261021_200355.webm` と `自習室_20261021_200355.speakers.json`
- 用途：文字起こし（DegiHara-ChatBot の podcast パイプライン等）で、各字幕行に話者を割り当てる。

## 仕組み

録画ミキサーは参加者ごとの音声を別トラックで受け取ってから1本に混ぜる。混ぜる前のトラックごとの音量で発話区間を判定するので、声質から話者を推測しない。実装は `lib/speaker-activity.ts`。

## 形式

```json
{
  "format": "jishushitsu-speakers",
  "version": 1,
  "recording": { "file": "自習室_20261021_200355.webm", "startedAt": "2026-10-21T11:03:55.000Z", "durationSec": 3600.5 },
  "timeBase": "録画ファイルの先頭を 0 とする秒",
  "detector": { "frameMs": 50, "thresholdDb": -45, "minSpeechMs": 150, "hangoverMs": 500 },
  "speakers": [
    { "id": "123456789", "name": "ガクチョ", "kind": "human" },
    { "id": "123456789#screen", "name": "ガクチョ", "kind": "screen" },
    { "id": "ai-participant:chatgpt", "name": "（AI 参加者の表示名）", "kind": "ai" }
  ],
  "segments": [
    { "speaker": "123456789", "start": 12.35, "end": 18.9 }
  ],
  "presence": [
    { "id": "123456789", "name": "ガクチョ", "kind": "human", "intervals": [{ "start": 0, "end": 3600.5 }] },
    { "id": "guest:abc", "name": "ゲスト", "kind": "human", "intervals": [{ "start": 600.2, "end": 1800.0 }] }
  ],
  "levels": [
    { "speaker": "123456789", "frames": 72010, "p10": -100, "median": -71, "p90": -28, "voicedRatio": 0.31 }
  ]
}
```

- `speakers[].id`：人間は LiveKit identity。画面共有の音声は `<identity>#screen`。
- `speakers[].name`：収録時点の表示名（Discord 名）。番組での呼び名とは一致しないことがある。例：ガクチョ＝塚ちゃん。対応表は使う側で持つ。
- `kind`：`human`（マイク）／`ai`（AI 参加者）／`screen`（画面共有の音声）／`other`。
- `segments`：開始時刻の順。複数の話者の区間は重なりうる（相づち・同時発話）。
- `presence`（2026-10-22 追加）：録画中に部屋にいた区間。録画開始時点の参加者は `start: 0`、録画終了時点でいた人は `end` が `durationSec`。途中退出と再入室は区間が分かれる。録画した本人も含む。
  - ある人の `segments` が無いとき、`presence` にその時間の区間があれば「いたが話していない」、無ければ「いなかった」。
  - 画面共有の音声（`#screen`）は、人ではないので `presence` に入らない。
- `levels`（2026-10-22 追加）：話者ごとの音量の分布（`segments` の判定に使ったのと同じ、50ms ごとの RMS dBFS を 1 dB 刻みで集計）。
  - `p10`／`median`／`p90`：下位10%・中央値・上位10%。無音（デジタルの 0）は -100 に丸める。録画の大半は黙っている時間なので、`median` は雑音の大きさに近く、声の大きさは `p90` を見る。
  - `voicedRatio`：しきい値（`detector.thresholdDb`）以上だったフレームの割合。
  - 使い方の例：`p90` がしきい値に近い人は声を取りこぼしやすい。`median` がしきい値に近い人は、雑音を発話と判定しやすい。
- `presence` と `levels` は `version: 1` のまま後から足した項目。2026-10-21 以前の speakers.json には無いので、読む側は無くても動くようにする。

## 使う側の注意

- 本編を切り出してから文字起こしする場合は、切り出し開始の秒数を `start`/`end` から引く。
- 字幕行への割り当ては、行の時間と区間の重なりが最大の話者を選ぶのが基本。重なりがない行は「不明」とする。
- ブラウザの初回ダウンロード時に「複数ファイルのダウンロード」の許可を求められることがある。許可しないと speakers.json が保存されない。
- クラッシュ後の復旧（IndexedDB）で戻るのは録画だけで、speakers.json は戻らない。
