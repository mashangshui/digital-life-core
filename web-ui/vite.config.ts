import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 只读桥跑在 8787；前端 5173。开发期用 proxy 规避跨域，生产构建也走同源。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 绑 ::（Windows 双栈默认同时接受 IPv4/IPv6）：否则只监听 [::1]，
    // 用 127.0.0.1 访问会被系统代理拦成 502。
    host: '::',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
