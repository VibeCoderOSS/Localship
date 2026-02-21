export const DEFAULT_API_URL = 'http://localhost:1234/v1/chat/completions'; // LM Studio default
export const DEFAULT_MODEL = 'local-model'; // Placeholder

// --- SYSTEM PROMPT (LOCAL LLM OPTIMIZED) ---
export const SYSTEM_PROMPT = `You are LocalShip, an expert React/Electron Engineer.

GOAL
Build a high-quality, offline-ready App.
- Stack: React 18, Vite, Tailwind CSS v3, Electron.
- NO external CDNs (fonts/scripts must be local or omitted).

OUTPUT FORMAT RULES
1. You must output VALID MARKER BLOCKS for all code changes.
2. Do not include diffs or explanations outside the blocks if possible.
3. Never output <tool_call>, <toolcall>, <tool>, <function_call>, or any tool syntax.
4. Do not use <details>, <summary>, or any HTML wrappers.
5. Do not use <patch: ...> or <function=...> wrappers. Use ONLY:
   <!-- filename: path/to/file.ext --> OR <!-- patch: path/to/file.ext -->
6. Single response mode: no prose outside marker blocks, no duplicate repeated patch blocks.

MODE A: CREATE NEW FILE
Use this for files not yet in [PROJECT MAP].
Filename blocks require fenced code.
<!-- filename: path/to/file.ext -->
\`\`\`ext
...full content...
\`\`\`

MODE B: PATCH EXISTING FILE
Use this for files found in [PROJECT MAP].
Patch blocks use XML ops only (no fenced wrapper required).
<!-- patch: path/to/file.ext -->
<replace>
  <find>
    ...exact code snippet to replace (3-10 lines)...
  </find>
  <with>
    ...new code...
  </with>
</replace>

<insert_after>
  <find>...unique anchor...</find>
  <with>...content to insert...</with>
</insert_after>

<delete>
  <find>...content to delete...</find>
</delete>

CRITICAL:
- The <find> block must match the existing file EXACTLY (ignoring indentation).
- Do not reinvent file paths. Use the ones provided.
- Do not create a new top-level src/ directory unless explicitly requested.
- External libraries are allowed only when using local project dependencies.
- Never use CDN scripts/styles at runtime.
- For 3D requests, prefer \`import * as THREE from 'three'\`.
- Make the app fit to the available space. Only implement scrolling when absolutely needed or asked.
- If you cannot produce a valid patch, output ONE valid <!-- filename: App.tsx --> fenced block as a safe fallback.
- For typical feature requests, modify ONLY App.tsx unless asked otherwise.
- Do not touch index.html, input.css, tailwind.config.js unless the request explicitly asks for it.

CANONICAL VALID OUTPUT EXAMPLES
<!-- filename: App.tsx -->
\`\`\`tsx
import React from 'react';

const App: React.FC = () => <div>Hello</div>;

export default App;
\`\`\`

<!-- patch: App.tsx -->
<replace>
  <find>
const title = "Old";
  </find>
  <with>
const title = "New";
  </with>
</replace>
`;

export const ELECTRON_MAIN_JS = `
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const autoprefixer = require('autoprefixer');

let mainWindow;

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: fs.existsSync(preloadPath) ? preloadPath : undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false 
    },
    backgroundColor: '#0f172a'
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    dialog.showErrorBox('Renderer Load Failed', code + ' ' + desc + '\\n' + url);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('Renderer Crashed', JSON.stringify(details));
  });

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const distPath = path.join(__dirname, 'dist/index.html');
    const rootPath = path.join(__dirname, 'index.html');
    mainWindow.loadFile(fs.existsSync(distPath) ? distPath : rootPath);
  }
}

app.whenReady().then(createWindow);

ipcMain.handle('compile-tailwind', async (event, { files, configCode, cssInput }) => {
  try {
    const content = Object.entries(files).map(([filename, code]) => ({
      raw: code,
      extension: filename.split('.').pop()
    }));

    let userConfig = { content: ["./**/*.{js,ts,jsx,tsx,html}"] };
    try {
      const configMatch = configCode.match(/module\\.exports\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;?/);
      if (configMatch) {
          const configBody = configMatch[1];
          const badTokens = ['require', 'import', 'function', '=>', 'process', 'globalThis', 'constructor', '__proto__', '/*', '//'];
          if (!badTokens.some(token => configBody.includes(token))) {
            userConfig = Function('"use strict"; return (' + configBody + ')')();
          }
      }
    } catch (e) {
      console.warn("Tailwind config parsing failed, using default.");
    }

    userConfig.content = content;

    const result = await postcss([
      tailwindcss(userConfig),
      autoprefixer
    ]).process(cssInput, { from: undefined });

    return { css: result.css };
  } catch (error) {
    console.error("Tailwind Compile Error:", error);
    return { error: error.message };
  }
});
`;

export const PRELOAD_JS = `const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('localship', { isPackaged: true });
`;

export const PACKAGE_JSON = (appName: string, author: string) => JSON.stringify({
  name: appName.toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
  version: "1.0.0",
  private: true,
  main: "main.js",
  scripts: {
    dev: "vite",
    "build:web": "vite build",
    start: "electron .",
    dist: "npm run build:web && electron-builder"
  },
  author: author,
  dependencies: {
    react: "^18.2.0",
    "react-dom": "^18.2.0",
    three: "^0.179.1",
    tailwindcss: "^3.4.17",
    autoprefixer: "^10.4.19",
    postcss: "^8.4.38"
  },
  devDependencies: { 
    electron: "^30.0.0", 
    "electron-builder": "^24.0.0",
    vite: "^5.4.8",
    "@vitejs/plugin-react": "^4.3.2",
    typescript: "^5.5.4",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0"
  }
}, null, 2);

export const README_MD = `# Generated App

Built with LocalShip & Tailwind v3.`;
