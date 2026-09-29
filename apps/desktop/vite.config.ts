import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function productionCsp(): Plugin {
  return {
    name: 'nec-production-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
  };
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), productionCsp()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
