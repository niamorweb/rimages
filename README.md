# Rimages ⚡️

A high-performance, desktop image compressor built with **Tauri v2**, **Rust**, and **React**.
Supports smart compression for JPG, PNG (Quantization), WebP, and AVIF.

![Screenshot](./public/demo-compressed.webp) ## Features 🚀

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

## Build It Yourself 📦

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Node.js](https://nodejs.org/) (v18 or higher)
- Build tools for your OS (see [Tauri's guide](https://v2.tauri.app/start/prerequisites/))

### Steps

1. **Clone the repository**:

```bash
git clone [https://github.com/niamorweb/rimages.git](https://github.com/niamorweb/rimages.git)
```

2. **Go into the app directory**:

```bash
cd rimages
```

3. **Install dependencies**:

```bash
npm install
```

4. **Run in Development mode**:

```bash
npm run tauri dev
```

5. **Build Production Installer (Optionnal)**:

```bash
npm run tauri build
```
