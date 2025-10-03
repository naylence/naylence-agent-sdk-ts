import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

export default defineConfig({
  input: 'src/browser.ts',
  output: {
    file: 'dist/browser/index.js',
    format: 'umd',
    name: 'NaylenceAgentSdk',
    sourcemap: true,
    inlineDynamicImports: true,
    globals: {
      'ws': 'null'
    }
  },
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false
    }),
    json(),
    commonjs(),
    typescript({
      target: 'es2020',
      module: 'node16',
      declaration: false,
      declarationMap: false,
      sourceMap: true
    })
  ],
  external: ['ws']
});
