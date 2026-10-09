import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4173', '/media': 'http://127.0.0.1:4173' },
    fs: { deny: ['**/.env*', '**/*API-Key*', '**/*.sqlite*', '**/data/**', '**/storage/**', '**/backups/**', '**/.git/**'] },
  },
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { output: { manualChunks(id) {
    if (/node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(id)) return 'react-vendor';
    if (/node_modules\/(react-hook-form|zod)\//.test(id)) return 'form-vendor';
  } } } },
});
