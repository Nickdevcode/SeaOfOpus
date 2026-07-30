import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // three and postprocessing almost never change; isolating each one in its
        // own chunk lets the browser's cache survive every deploy of the game's
        // code. Rolldown's API (Vite 8's default bundler) — the old object-shaped
        // `manualChunks` was replaced by `codeSplitting.groups`.
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'postprocessing', test: /node_modules[\\/]postprocessing[\\/]/ },
          ],
        },
      },
    },
  },
});
