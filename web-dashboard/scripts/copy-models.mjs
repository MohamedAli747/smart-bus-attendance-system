import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceOnnx = join(root, '..', 'attendance', 'models', 'w600k_mbf.onnx');
const sourceTflite = join(root, '..', 'attendance', 'models', 'w600k_mbf.tflite');
const sourceWasmDir = join(root, 'node_modules', '@tensorflow', 'tfjs-tflite', 'wasm');
const destDir = join(root, 'public', 'models');
const destWasmDir = join(root, 'public', 'tflite-wasm');
const destOnnx = join(destDir, 'w600k_mbf.onnx');
const destTflite = join(destDir, 'w600k_mbf.tflite');

if (!existsSync(sourceTflite)) {
  console.error(`Missing source model: ${sourceTflite}`);
  console.error('Place w600k_mbf.tflite in attendance/models/.');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
if (existsSync(sourceOnnx)) {
  copyFileSync(sourceOnnx, destOnnx);
  console.log(`Copied ${sourceOnnx} -> ${destOnnx}`);
}
copyFileSync(sourceTflite, destTflite);
console.log(`Copied ${sourceTflite} -> ${destTflite}`);

if (existsSync(sourceWasmDir)) {
  mkdirSync(destWasmDir, { recursive: true });
  cpSync(sourceWasmDir, destWasmDir, { recursive: true });
  console.log(`Copied TFLite wasm assets from ${sourceWasmDir} -> ${destWasmDir}`);
} else {
  console.warn(`TFLite wasm source directory not found: ${sourceWasmDir}`);
}
