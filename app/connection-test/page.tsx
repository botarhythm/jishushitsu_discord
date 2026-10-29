import type { Metadata } from 'next';
import ConnectionTest from '@/components/ConnectionTest';

export const metadata: Metadata = {
  title: '接続テスト | デジタル原っぱ大学 自習室',
  description: 'この PC から自習室のサーバーへ映像と音声を送れるかを調べる。',
};

export default function ConnectionTestPage() {
  return <ConnectionTest />;
}
