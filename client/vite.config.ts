import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In dev, /api calls go to the Express server on port 4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: {
    chunkSizeWarningLimit: 6000, // Monaco editor is big, it is lazy-loaded
  },
})
