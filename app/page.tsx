'use client';

import { Suspense } from 'react';
import LandingContent from '@/components/LandingContent';

export default function Home() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen bg-stone-50">読み込み中...</div>}>
      <LandingContent />
    </Suspense>
  );
}
