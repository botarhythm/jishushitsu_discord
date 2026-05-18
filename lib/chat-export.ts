import type { ReceivedChatMessage } from '@livekit/components-react';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildText(messages: ReceivedChatMessage[]): string {
  const header = [
    'デジタル原っぱ大学 自習室 チャットログ',
    `エクスポート日時: ${formatTimestamp(Date.now())}`,
    `メッセージ数: ${messages.length}`,
    '',
    '----------------------------------------',
    '',
  ].join('\n');
  const body = messages
    .map((m) => {
      const name = m.from?.name?.trim() || m.from?.identity || '匿名';
      const id = m.from?.identity ? ` <${m.from.identity}>` : '';
      return `[${formatTimestamp(m.timestamp)}] ${name}${id}\n${m.message}\n`;
    })
    .join('\n');
  return header + body;
}

/**
 * チャット履歴を .txt として自動ダウンロードする。
 * メッセージが空のときは何もしない。
 */
export function downloadChatHistory(messages: ReceivedChatMessage[]): void {
  if (!messages || messages.length === 0) return;
  const text = buildText(messages);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const now = new Date();
  const ts =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const fname = `自習室_チャット_${ts}.txt`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
