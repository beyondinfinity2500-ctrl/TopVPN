// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://www.topvpn.top',
  output: 'static',
  trailingSlash: 'never',
  compressHTML: true,
  build: {
    // about.html -> served at /about (matches our canonical URLs on Cloudflare)
    format: 'file',
    inlineStylesheets: 'always',
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
