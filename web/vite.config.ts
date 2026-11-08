import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const API = process.env.TINYWEBUI_API || 'http://127.0.0.1:7777';

// The page is built into ../dist, which the server serves (server/http.ts) and the
// npm package ships. `web/public` (themes, icons) is copied over as is.
export default defineConfig({
  root: here('.'),
  plugins: [vue()],
  build: {
    outDir: here('../dist'),
    emptyOutDir: true,
    // The server's CSP has no 'unsafe-inline': every script and stylesheet has
    // to be a file, never inlined into index.html.
    assetsInlineLimit: 0,
    sourcemap: false
  },
  server: {
    port: 5173,
    // `npm run dev` runs the API on 7777. Its cross-site guard (server/http.ts)
    // refuses a POST whose Origin is not its own host, so the proxy presents
    // every request as coming from the API's own origin.
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', (req) => { if (req.getHeader('origin')) req.setHeader('origin', API); })
      }
    }
  }
});
