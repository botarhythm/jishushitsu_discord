import { MediaDeviceFailure } from 'livekit-client';

/**
 * ブラウザの権限設定画面 (chrome:// 等) へは Web ページからリンクできないため、
 * 権限拒否時は端末を判別して「その環境での操作手順」を文言で案内するしかない。
 * ここはその判別。UA だけに頼らず iPadOS の Macintosh 偽装は maxTouchPoints で拾う。
 */
function detectPlatform(): 'android' | 'ios' | 'desktop' {
  if (typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** 権限拒否 (ブラウザ設定の変更 + 再読み込みで直る系) の失敗か */
export function isPermissionFailure(error: Error | undefined): boolean {
  return MediaDeviceFailure.getFailure(error) === MediaDeviceFailure.PermissionDenied;
}

/** 権限拒否時の、端末別の復旧手順つきメッセージ */
function describePermissionDenied(deviceLabel: string): string {
  switch (detectPlatform()) {
    case 'android':
      return (
        `${deviceLabel}の使用が許可されませんでした。ブラウザの設定から許可できます:\n` +
        '1. アドレスバー左の鍵マーク 🔒 (または設定アイコン) をタップ\n' +
        '2. 「権限」でカメラとマイクを「許可」に変更\n' +
        '3. このページを再読み込み\n' +
        '「権限」の項目が出ない場合は、端末の 設定 → アプリ → Chrome → 権限 でカメラとマイクを許可してください。\n' +
        'LINE・Instagram などのアプリ内ブラウザで開いている場合はカメラ/マイクが使えないことがあります。メニューから「他のブラウザで開く」で Chrome で開き直してください。'
      );
    case 'ios':
      return (
        `${deviceLabel}の使用が許可されませんでした。ブラウザの設定から許可できます:\n` +
        '1. アドレスバー左の「ぁあ」をタップ →「Webサイトの設定」\n' +
        '2. カメラとマイクを「許可」に変更\n' +
        '3. このページを再読み込み\n' +
        'それでも直らない場合は、端末の 設定 → Safari → カメラ/マイク を「確認」または「許可」にしてください。\n' +
        'LINE・Instagram などのアプリ内ブラウザで開いている場合は、メニューから「Safariで開く」で開き直してください。'
      );
    default:
      return (
        `${deviceLabel}の使用が許可されませんでした。ブラウザの設定から許可できます:\n` +
        '1. アドレスバーの右端 (またはURL左の鍵マーク) にあるカメラのアイコンをクリック\n' +
        '2. カメラとマイクを「許可」に変更\n' +
        '3. このページを再読み込み'
      );
  }
}

/**
 * カメラ/マイクの getUserMedia 失敗を、利用者が次に何をすればいいか分かる文言に変換する。
 * PermissionDenied は「権限ダイアログを拒否した」以外に、LINE/Instagram 等のアプリ内蔵ブラウザ
 * (WebView) がそもそもカメラ/マイク権限を仲介できず即座に失敗するケースが非常に多いため、
 * その場合の対処 (Chrome 等の通常ブラウザで開き直す) も併記する。
 */
export function describeMediaDeviceFailure(error: Error | undefined, deviceLabel: string): string {
  // MediaDeviceFailure.getFailure は NotFoundError/NotAllowedError/NotReadableError 系のみを
  // 判別し、OverconstrainedError と AbortError は Other に丸め込む。iOS Safari は
  // constraint 付きでなくとも OverconstrainedError を返すことがあり、また初回呼び出しで
  // AbortError を返すことがある (いずれもWebKit特有の一時的な失敗で、Chromeへの乗り換えは
  // 解決策にならない) ため、先に個別に判定する。
  if (error?.name === 'AbortError') {
    return `${deviceLabel}の起動中に一時的なエラーが発生しました。もう一度お試しください。`;
  }
  if (error?.name === 'OverconstrainedError') {
    return `${deviceLabel}がこの端末の設定に対応できませんでした。別のカメラ/マイクを選択するか、再度お試しください。`;
  }

  const failure = MediaDeviceFailure.getFailure(error);
  switch (failure) {
    case MediaDeviceFailure.PermissionDenied:
      return describePermissionDenied(deviceLabel);
    case MediaDeviceFailure.NotFound:
      return `${deviceLabel}が見つかりませんでした。端末にカメラ/マイクが接続・搭載されているか確認してください。`;
    case MediaDeviceFailure.DeviceInUse:
      return `${deviceLabel}は他のアプリが使用中の可能性があります。他のアプリを閉じてから再度お試しください。`;
    default:
      return (
        `${deviceLabel}を起動できませんでした。ブラウザの権限設定を確認するか、` +
        '通常のブラウザ(Chrome・Safariなど)で開き直してお試しください。'
      );
  }
}

/**
 * getDisplayMedia (画面/タブ共有によるローカル録画) の失敗を日本語メッセージに変換する。
 * iOS Safari は getDisplayMedia 自体が存在しないため (iPhoneの全ブラウザがWebKitベースで同様)、
 * 呼び出し前に isDisplayMediaSupported() で feature-detect した上でこの関数を使うことを想定している。
 * ここでの分岐は「対応環境で呼び出した後に失敗した」ケース向け。
 */
export function describeDisplayMediaFailure(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotFoundError':
        return '共有できる画面が見つかりませんでした。';
      case 'NotReadableError':
        return '画面の取得に失敗しました。他のアプリを閉じてから再度お試しください。';
      case 'AbortError':
        return '画面共有が中断されました。もう一度お試しください。';
      default:
        break;
    }
  }
  return (
    '録画を開始できませんでした。パソコンのChrome・Edgeなど画面共有に対応したブラウザでお試しください。'
  );
}

/** getDisplayMedia (画面/タブ共有) に対応しているか。iOS Safari 等では常に false。 */
export function isDisplayMediaSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}
