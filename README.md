# LocalShip

Build and ship React/Electron apps with local LLMs, offline-first.

![Ship-42 Logo](public/ship42-logo.jpeg)

## What It Does

- Uses local OpenAI-compatible endpoints (for example LM Studio) to generate and patch project files.
- Supports guided non-coder flow (`Make` / `Change-Improve` / `Ask`) and advanced mode.
- Runs a live preview with last-known-good fallback for safer iteration.
- Applies parser/repair logic for imperfect model outputs.
- Exports native desktop apps via Electron Builder (`.dmg`, `.exe`, `.AppImage`).

## Tech Stack

- React 18 + TypeScript + Vite
- Tailwind CSS v3
- Electron

## Prerequisites

- Node.js 18+ and npm
- A local LLM server exposing an OpenAI-compatible API
- macOS/Windows/Linux (for target-specific native builds)

## Installation

Clone and install:

```bash
git clone https://github.com/VibeCoderOSS/Localship.git
cd Localship
npm install
```

If vendor/setup assets were not prepared automatically, run:

```bash
npm run prepare
```

Start your local LLM server, then launch the app:

```bash
npm run electron:dev
```

## Development

Install dependencies:

```bash
npm install
```

Run web dev mode:

```bash
npm run dev
```

Run Electron + Vite dev mode:

```bash
npm run electron:dev
```

## Build

Build web app:

```bash
npm run build
```

Build native app:

```bash
npm run dist
```

Artifacts are written to `release/`.

## Tests

```bash
npm run test:parser
npm run test:prompt-composer
npm run test:stream-memory
```

## Project Structure

- `App.tsx` - app shell and orchestration
- `components/` - UI components (preview, settings, composer, modals)
- `services/` - LLM integration, parsing, orchestration, model registry
- `utils/` - project validation, export, prompt composition
- `scripts/` - regression and setup scripts

## Notes

- The app is designed for local/offline workflows.
- External runtime CDNs are intentionally avoided.
- This project is currently in **beta**.
- It has been specifically tested with [`mlx-community/Qwen3-Coder-Next-8bit`](https://huggingface.co/mlx-community/Qwen3-Coder-Next-8bit).
- Support and behavior with other models have not been tested yet.
