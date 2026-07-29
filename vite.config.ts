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
        // three e postprocessing quase nunca mudam; isolar cada um em seu chunk
        // faz o cache do navegador sobreviver a cada deploy do código do jogo.
        // API do Rolldown (bundler padrão do Vite 8) — o antigo `manualChunks`
        // em forma de objeto foi substituído por `codeSplitting.groups`.
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
