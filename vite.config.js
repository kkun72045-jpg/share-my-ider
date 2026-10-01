import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: {
      input: { panel: resolve('panel.html'), engine: resolve('engine.html'), background: resolve('src/background.ts') },
      output: { entryFileNames: 'assets/[name].js', chunkFileNames: 'assets/[name]-[hash].js' }
    }
  }
});
