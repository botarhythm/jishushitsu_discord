import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
    resolveAlias: {
      // ebml の package.json "browser" フィールドは module.exports を持たない
      // IIFE ビルド (lib/ebml.iife.js) を指しており、ブラウザバンドルでは ts-ebml 内の
      // require("ebml") が空を受け取り `tools.readVint` 参照でモジュール評価ごと落ちる。
      // 依存を全て内蔵した ESM ビルドへ張り替えてブラウザでも動くようにする
      // (録画 WebM への Duration/Cues 注入 = injectWebmSeekMetadata が依存)。
      ebml: { browser: 'ebml/lib/ebml.esm.js' },
    },
  },
};

export default nextConfig;
