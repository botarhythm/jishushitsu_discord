import { Fragment, type ReactNode } from 'react';

// チャット本文の http(s) URL をリンクにする。
// 日本語の直後に続く場合に備え、URL として使える ASCII 文字だけを拾う。
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
const TRAILING_PUNCT = /[.,!?:;'\]]+$/;

// 文末の句読点や、対になっていない閉じカッコは URL に含めない。
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCT, '');
  while (url.endsWith(')')) {
    const open = (url.match(/\(/g) ?? []).length;
    const close = (url.match(/\)/g) ?? []).length;
    if (close <= open) break;
    url = url.slice(0, -1).replace(TRAILING_PUNCT, '');
  }
  return url;
}

export function LinkifiedText({ text, linkClassName }: { text: string; linkClassName?: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    if (url.length <= 'https://'.length) continue;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`break-all underline underline-offset-2 ${linkClassName ?? ''}`}
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Fragment>{parts}</Fragment>;
}
