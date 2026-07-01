import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_JP } from 'next/font/google';
import '@livekit/components-styles';
import './globals.css';

const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
});

const notoSansJP = Noto_Sans_JP({
  variable: '--font-noto-sans-jp',
  subsets: ['latin'],
  weight: ['400', '500', '700'],
});

export const metadata: Metadata = {
  title: 'デジタル原っぱ大学 自習室',
  description: 'AIと共に思考と実装の距離をゼロにする、オンライン学習空間',
};

// viewportFit: 'cover' を今のうちに有効化しておく (現状 env(safe-area-inset-*) を使う
// CSS はまだ無いため見た目への影響はゼロ)。将来 iPhone のホーム画面追加/PWA化を行う際に、
// これが無いと env() が常に0pxに解決されてノッチ/ホームインジケータ対応が丸ごと無効化される。
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${inter.variable} ${notoSansJP.variable} h-full`}>
      <body className="min-h-full bg-stone-50 text-stone-900 font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
