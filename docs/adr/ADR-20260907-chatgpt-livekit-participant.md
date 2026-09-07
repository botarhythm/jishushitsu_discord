# ADR: ChatGPTを予約LiveKit参加者として公開する

- status: accepted
- date: 2026-09-07
- requirements: `docs/requirements/chatgpt-all-participants.md` v2

## Context

従来は講師のLiveKit接続からAI音声をpublishし、講師だけはhidden audioで直接再生し、録画には別registryから渡していた。この構成は収録モードに依存し、通常グリッドにAIが参加者として現れず、同じAI返答を複数経路で再生・録音する危険がある。

## Decision

講師ブラウザ内に受信を行わない第2のLiveKit `Room` 接続を作り、予約identity `ai-participant:chatgpt` でAI音声を1トラックだけpublishする。トークンは講師セッションと対象ルーム在籍をサーバーで確認して発行する。同じルームで予約identityが既に存在する場合は開始を拒否する。同時開始で置換された接続は停止し、自動再取得しない。

人間側Roomは通常の `RoomAudioRenderer` でAI音声を一度だけ再生する。ローカル録画も人間側Roomが受信したリモートAIトラックを一度だけ取り込む。従来のhidden audioとAI registry登録は使わない。ChatGPT入力ミキサーは人間側Roomに接続し、AIプレフィックスのトラックを除外する。

AIの有効化は収録モードから独立させる。収録metadataが必要な場合だけ、予約identityをAI descriptorのownerとして配信する。

## Consequences

- 通常グリッドはLiveKit参加者一覧からChatGPTを自然に表示できる。
- 全参加者と録画で音声経路を共有でき、二重再生・二重録音を避けられる。
- LiveKitの同一identityはlast-join-winsなので厳密な先着保証はしない。置換検知後の手動再開を要求する。
- ChatGPT Classicの内部マイク選択はブラウザから変更できないため、初回または外部変更時は明示確認が残る。

## Rollback

AIを無効化すると第2接続、provider、ミキサーを破棄する。問題時はこの機能を使わず既存通話と録画を継続できる。
