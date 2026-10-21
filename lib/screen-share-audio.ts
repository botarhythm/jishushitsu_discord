/**
 * 画面共有で音声も共有するかの設定 (端末ごと / localStorage)。
 *
 * 既定は ON。動画や資料の音を通話相手と収録に届けるのが目的。
 * 実際に音声が取れるかはブラウザと共有対象で決まる (Chrome はタブ共有と
 * Windows の画面全体共有のみ。ウィンドウ共有や Safari では音声なしになる)。
 */
const STORAGE_KEY = 'jishushitsu.screenShareAudio';

export function loadScreenShareAudio(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function saveScreenShareAudio(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // プライベートモード等。このタブの間だけ有効な設定になる
  }
}
