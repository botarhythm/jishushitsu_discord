/**
 * 自動切り替えで TLS 中継にして直った端末を覚え、次の入室から最初に TLS 中継へ切り替える。
 *
 * この端末のブラウザ (localStorage) にだけ、期限の日時を 1 つ置く。期限が切れたら、また通常の経路から試す。
 * 回線や場所が変われば UDP で問題ないこともあるため、ずっとは覚えない。
 */
const KEY = 'jishushitsu:prefer-tls-until';
const REMEMBER_DAYS = 14;

export function shouldStartWithTls(): boolean {
  try {
    const until = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

export function rememberTls(): void {
  try {
    window.localStorage.setItem(KEY, String(Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000));
  } catch {
    // 保存できない（プライベートモードなど）なら、毎回通常の経路から試す
  }
}
