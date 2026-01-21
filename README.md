# Rimages ⚡️

A high-performance, desktop image compressor built with **Tauri v2**, **Rust**, and **React**.
Supports smart compression for JPG, PNG (Quantization), WebP, and AVIF.

![Screenshot](demo-compressed.webp) ## Features 🚀

- **Lightning Fast**: Uses `Rayon` for multi-threaded parallel processing.
- **Smart Optimization**:
  - **AVIF**: Uses `ravif` (speed/quality balanced).
  - **PNG**: Uses `imagequant` for smart color reduction (TinyPNG style).
  - **WebP**: Native lossy compression via `libwebp`.
- **UX First**: Real-time gain estimation, drag & drop, native file explorer integration.
- **Privacy**: Everything happens offline on your CPU. No cloud.

## Tech Stack 🛠

- **Frontend**: React, TypeScript, Vite.
- **Backend**: Rust (Tauri).
- **Core Libraries**:
  - `rayon` (Parallelism)
  - `ravif` (AVIF encoder)
  - `imagequant` (PNG optimization)
  - `tauri-plugin-fs` / `dialog`

## Build it yourself 📦

1. Install Rust and Node.js.
2. Clone the repo.
3. Install dependencies:
   ```bash
   npm install
   ```
