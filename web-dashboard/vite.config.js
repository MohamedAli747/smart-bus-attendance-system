import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@tensorflow/tfjs-tflite': path.resolve(
        __dirname,
        'node_modules/@tensorflow/tfjs-tflite/dist/tf-tflite.es2017.js'
      ),
    },
  },
})
