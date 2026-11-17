import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  publicDir: false,
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: path.resolve(__dirname, 'wp-plugin/kiseki-relation-graph/assets'),
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, 'src/admin/admin-entry.tsx'),
      name: 'KisekiRelationAdminBundle',
      formats: ['iife'],
      fileName: () => 'admin.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'admin.[ext]',
      },
    },
  },
});
