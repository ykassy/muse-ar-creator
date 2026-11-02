import { defineConfig } from 'vite';

// One self-contained ES module (three r186 bundled in) that the HACKAR:S player imports lazily,
// only for projects that have an Ultra FX overlay.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    minify: true,
    lib: { entry: 'src/host.js', formats: ['es'], fileName: () => 'ultra-host.js' },
    rollupOptions: { output: { codeSplitting: false } },
  },
});
