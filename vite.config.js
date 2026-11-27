import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two pages: the landing page at / (plain HTML on the design kit in public/assets) and the app at /app/.
// Bundled files go to dist/static so they never mix with the kit's public/assets.
export default defineConfig({
  plugins: [react()],
  build: {
    assetsDir: 'static',
    rollupOptions: { input: { main: 'index.html', app: 'app/index.html' } },
  },
});
