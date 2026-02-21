
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// CSS Processing
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');
const autoprefixer = require('autoprefixer');

let mainWindow;
let rendererRecoveryAttempts = 0;
let rendererRecoveryWindowStart = 0;
const RENDERER_RECOVERY_WINDOW_MS = 60000;
const MAX_RENDERER_RECOVERY_ATTEMPTS = 1;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false 
    },
    backgroundColor: '#0f172a',
    title: "LocalShip"
  });

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist/index.html'));
  }

  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    dialog.showErrorBox('Renderer Load Failed', `${code} ${desc}\n${url}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    const now = Date.now();
    if (!rendererRecoveryWindowStart || (now - rendererRecoveryWindowStart) > RENDERER_RECOVERY_WINDOW_MS) {
      rendererRecoveryWindowStart = now;
      rendererRecoveryAttempts = 0;
    }

    const recoverable = reason === 'oom' || reason === 'crashed';
    if (recoverable && rendererRecoveryAttempts < MAX_RENDERER_RECOVERY_ATTEMPTS && mainWindow && !mainWindow.isDestroyed()) {
      rendererRecoveryAttempts += 1;
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.reloadIgnoringCache();
          } catch {}
        }
      }, 300);
      return;
    }

    dialog.showErrorBox(
      'Renderer Recovery Failed',
      `Renderer process exited (${reason}). Please restart LocalShip if this repeats.`
    );
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- TAILWIND JIT COMPILATION ---
ipcMain.handle('compile-tailwind', async (event, { files, configCode, cssInput }) => {
  try {
    // Transform files into Tailwind's expected content format
    const content = Object.entries(files || {}).map(([filename, code]) => ({
      raw: code,
      extension: filename.split('.').pop()
    })).filter((entry) => typeof entry.raw === 'string' && entry.raw.trim().length > 0);

    // Simple config parsing
    let userConfig = { content: ["./**/*.{js,ts,jsx,tsx,html}"] };
    try {
      const configMatch = configCode.match(/module\.exports\s*=\s*(\{[\s\S]*\})/);
      if (configMatch) {
          const parsed = Function(`"use strict"; return (${configMatch[1]})`)();
          if (parsed && typeof parsed === 'object') userConfig = parsed;
      }
    } catch (e) {
      console.warn("Config parse failed, using default.");
    }

    if (content.length === 0) {
      content.push({ raw: '<div class="p-2 text-sm"></div>', extension: 'html' });
    }
    userConfig.content = content;

    const result = await postcss([
      tailwindcss(userConfig),
      autoprefixer
    ]).process(cssInput, { from: 'input.css' });

    return { css: result.css, warning: content.length === 1 && content[0].raw === '<div class="p-2 text-sm"></div>' ? 'tailwind_fallback_content_used' : undefined };
  } catch (error) {
    return { error: error.message };
  }
});

// --- DIALOGS & BUILD SYSTEM ---
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

// --- PROJECT STORAGE ---
const safeSlug = (name) => name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'localship-project';
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });
const versionsRoot = (projectDir) => path.join(projectDir, '.localship');
const versionsIndex = (projectDir) => path.join(versionsRoot(projectDir), 'versions.json');
const versionsDir = (projectDir) => path.join(versionsRoot(projectDir), 'versions');
const workspaceIndex = (projectDir) => path.join(versionsRoot(projectDir), 'workspace.json');

const isIgnoredPath = (segment) => {
  return ['node_modules', '.localship', '.git', 'dist', 'build', 'release', 'out'].includes(segment);
};

const readProjectFiles = (projectDir) => {
  const files = {};
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (entry.name.startsWith('.DS_Store')) return;
      if (isIgnoredPath(entry.name)) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        return;
      }
      const rel = path.relative(projectDir, fullPath);
      const ext = path.extname(entry.name).toLowerCase();
      const allowed = ['.html', '.tsx', '.ts', '.js', '.jsx', '.css', '.json', '.md', '.txt', '.config.js'];
      if (!allowed.includes(ext)) return;
      try {
        files[rel] = fs.readFileSync(fullPath, 'utf-8');
      } catch {}
    });
  };
  walk(projectDir);
  return files;
};

ipcMain.handle('project-init', async (_event, { baseDir, name }) => {
  const projectDir = path.join(baseDir, safeSlug(name));
  ensureDir(projectDir);
  ensureDir(versionsRoot(projectDir));
  ensureDir(versionsDir(projectDir));
  if (!fs.existsSync(versionsIndex(projectDir))) {
    fs.writeFileSync(versionsIndex(projectDir), JSON.stringify([], null, 2), 'utf-8');
  }
  return { projectDir };
});

ipcMain.handle('project-validate', async (_event, { projectDir }) => {
  try {
    return { exists: !!projectDir && fs.existsSync(projectDir) };
  } catch {
    return { exists: false };
  }
});

ipcMain.handle('project-save-workspace', async (_event, { projectDir, files }) => {
  try {
    if (!projectDir) return { success: false, error: 'Missing projectDir' };
    ensureDir(projectDir);
    ensureDir(versionsRoot(projectDir));

    const previousIndex = fs.existsSync(workspaceIndex(projectDir))
      ? JSON.parse(fs.readFileSync(workspaceIndex(projectDir), 'utf-8'))
      : { files: [] };
    const previousFiles = Array.isArray(previousIndex.files) ? previousIndex.files : [];

    const nextFiles = Object.keys(files || {});
    // Remove files that were previously managed but are no longer present.
    previousFiles.forEach((filename) => {
      if (!nextFiles.includes(filename)) {
        const targetPath = path.join(projectDir, filename);
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
      }
    });

    for (const [filename, content] of Object.entries(files || {})) {
      const targetPath = path.join(projectDir, filename);
      ensureDir(path.dirname(targetPath));
      fs.writeFileSync(targetPath, content, 'utf-8');
    }

    fs.writeFileSync(workspaceIndex(projectDir), JSON.stringify({ files: nextFiles, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('project-load-workspace', async (_event, { projectDir }) => {
  try {
    if (!projectDir) return { files: null };
    if (!fs.existsSync(workspaceIndex(projectDir))) return { files: null };
    const index = JSON.parse(fs.readFileSync(workspaceIndex(projectDir), 'utf-8'));
    const fileList = Array.isArray(index.files) ? index.files : [];
    const files = {};
    fileList.forEach((filename) => {
      const targetPath = path.join(projectDir, filename);
      if (fs.existsSync(targetPath)) {
        files[filename] = fs.readFileSync(targetPath, 'utf-8');
      }
    });
    return { files };
  } catch {
    return { files: null };
  }
});

ipcMain.handle('project-import', async (_event, { projectDir }) => {
  try {
    if (!projectDir || !fs.existsSync(projectDir)) return { files: {} };
    ensureDir(versionsRoot(projectDir));
    ensureDir(versionsDir(projectDir));
    if (!fs.existsSync(versionsIndex(projectDir))) {
      fs.writeFileSync(versionsIndex(projectDir), JSON.stringify([], null, 2), 'utf-8');
    }
    const files = readProjectFiles(projectDir);
    fs.writeFileSync(workspaceIndex(projectDir), JSON.stringify({ files: Object.keys(files), savedAt: new Date().toISOString() }, null, 2), 'utf-8');
    return { files };
  } catch {
    return { files: {} };
  }
});

ipcMain.handle('project-list-versions', async (_event, { projectDir }) => {
  try {
    if (!fs.existsSync(versionsIndex(projectDir))) return [];
    const raw = fs.readFileSync(versionsIndex(projectDir), 'utf-8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
});

ipcMain.handle('project-save-version', async (_event, { projectDir, version }) => {
  try {
    ensureDir(versionsRoot(projectDir));
    ensureDir(versionsDir(projectDir));
    const id = version.id;
    const filePath = path.join(versionsDir(projectDir), `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ files: version.files, meta: { id, label: version.label, createdAt: version.createdAt, summary: version.summary } }, null, 2), 'utf-8');

    const listRaw = fs.existsSync(versionsIndex(projectDir)) ? fs.readFileSync(versionsIndex(projectDir), 'utf-8') : '[]';
    const list = Array.isArray(JSON.parse(listRaw)) ? JSON.parse(listRaw) : [];
    const existing = list.find((v) => v.id === id);
    if (!existing) {
      list.push({ id, label: version.label, createdAt: version.createdAt, summary: version.summary });
      fs.writeFileSync(versionsIndex(projectDir), JSON.stringify(list, null, 2), 'utf-8');
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('project-load-version', async (_event, { projectDir, id }) => {
  const filePath = path.join(versionsDir(projectDir), `${id}.json`);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return { files: parsed.files || {}, meta: parsed.meta || { id } };
});

ipcMain.handle('build-app', async (event, data) => {
    const log = (msg) => event.sender.send('build-log', msg);
    const err = (msg) => event.sender.send('build-error', msg);
    let buildRoot = null;
    let outputDir = null;

    const cleanupArtifacts = (dir, targetPlatform) => {
      if (!dir || !fs.existsSync(dir)) return [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const keepExts = targetPlatform?.startsWith('mac')
        ? ['.dmg']
        : targetPlatform === 'windows'
          ? ['.exe']
          : targetPlatform === 'linux'
            ? ['.appimage']
            : [];
      const removed = [];
      entries.forEach((entry) => {
        if (!entry.isFile()) return;
        const fullPath = path.join(dir, entry.name);
        const lower = entry.name.toLowerCase();
        const ext = path.extname(lower);
        if (keepExts.length > 0) {
          if (!keepExts.includes(ext)) {
            fs.unlinkSync(fullPath);
            removed.push(entry.name);
          }
          return;
        }
        if (lower.endsWith('.blockmap') || lower.endsWith('.zip') || lower.endsWith('.yml') || lower.endsWith('.yaml')) {
          fs.unlinkSync(fullPath);
          removed.push(entry.name);
        }
      });
      return removed;
    };

    const findArtifacts = (dir, depth = 2) => {
      if (!dir || !fs.existsSync(dir) || depth < 0) return [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const artifacts = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          artifacts.push(...findArtifacts(fullPath, depth - 1));
        } else {
          const lower = entry.name.toLowerCase();
          if (lower.endsWith('.dmg') || lower.endsWith('.exe') || lower.endsWith('.appimage')) {
            artifacts.push(fullPath);
          }
        }
      }
      return artifacts;
    };

    const selectPrimaryArtifact = (artifacts, targetPlatform) => {
      if (!artifacts || artifacts.length === 0) return null;
      const preferExt = targetPlatform?.startsWith('mac')
        ? '.dmg'
        : targetPlatform === 'windows'
          ? '.exe'
          : targetPlatform === 'linux'
            ? '.appimage'
            : '';
      const sorted = [...artifacts].sort((a, b) => {
        try {
          return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
      if (preferExt) {
        const preferred = sorted.find((p) => p.toLowerCase().endsWith(preferExt));
        if (preferred) return preferred;
      }
      return sorted[0];
    };

    try {
      if (!data || !data.files || !data.appName) {
        return { success: false, error: "Invalid build payload." };
      }

      buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localship-build-'));
      log(`Build root: ${buildRoot}`);

      const projectFiles = { ...(data.files || {}) };
      const run = (cmd, args) => new Promise((resolve, reject) => {
        log(`$ ${cmd} ${args.join(' ')}`);
        const child = spawn(cmd, args, { cwd: buildRoot, shell: false });
        child.stdout.on('data', (d) => log(d.toString()));
        child.stderr.on('data', (d) => log(d.toString()));
        child.on('error', (e) => reject(e));
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${cmd} exited with code ${code}`));
        });
      });

      const writeFile = (filename, content) => {
        const targetPath = path.join(buildRoot, filename);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, 'utf-8');
      };

      const resolveEntry = () => {
        const candidates = [
          'index.tsx', 'index.jsx', 'main.tsx', 'main.jsx',
          'src/index.tsx', 'src/index.jsx', 'src/main.tsx', 'src/main.jsx'
        ];
        return candidates.find((name) => projectFiles[name] !== undefined) || '';
      };

      const ensureIndexHtml = (entryFile) => {
        if (projectFiles['index.html']) return;
        const entrySrc = `/${entryFile.replace(/\\/g, '/')}`;
        projectFiles['index.html'] = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${data.appName || 'LocalShip App'}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${entrySrc}"></script>
  </body>
</html>`;
      };

      const ensureBuildConfig = () => {
        if (!projectFiles['vite.config.ts'] && !projectFiles['vite.config.js']) {
          projectFiles['vite.config.ts'] = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
});
`;
        }
      };

      const normalizeDistAssetPaths = () => {
        const distDir = path.join(buildRoot, 'dist');
        const indexPath = path.join(distDir, 'index.html');
        if (!fs.existsSync(indexPath)) return;

        let html = fs.readFileSync(indexPath, 'utf-8');
        html = html.replace(/(src|href)=["']\/(?!\/)/g, '$1="./');
        fs.writeFileSync(indexPath, html, 'utf-8');

        const assetsDir = path.join(distDir, 'assets');
        if (!fs.existsSync(assetsDir)) return;
        const entries = fs.readdirSync(assetsDir);
        entries.forEach((name) => {
          if (!name.endsWith('.css')) return;
          const cssPath = path.join(assetsDir, name);
          let css = fs.readFileSync(cssPath, 'utf-8');
          css = css.replace(/url\((['"]?)\/(?!\/)/g, 'url($1./');
          fs.writeFileSync(cssPath, css, 'utf-8');
        });
      };

      const parsePackage = () => {
        let parsed = {};
        try {
          parsed = JSON.parse(data.packageJson || '{}');
        } catch {
          parsed = {};
        }
        const dependencies = { ...(parsed.dependencies || {}) };
        const devDependencies = { ...(parsed.devDependencies || {}) };
        dependencies.react = dependencies.react || '^18.2.0';
        dependencies['react-dom'] = dependencies['react-dom'] || '^18.2.0';
        dependencies.three = dependencies.three || '^0.179.1';
        dependencies.postcss = dependencies.postcss || '^8.4.38';
        dependencies.tailwindcss = dependencies.tailwindcss || '^3.4.17';
        dependencies.autoprefixer = dependencies.autoprefixer || '^10.4.19';

        devDependencies.electron = devDependencies.electron || '^30.0.0';
        devDependencies['electron-builder'] = devDependencies['electron-builder'] || '^24.0.0';
        devDependencies.vite = devDependencies.vite || '^5.4.8';
        devDependencies['@vitejs/plugin-react'] = devDependencies['@vitejs/plugin-react'] || '^4.3.2';
        devDependencies.typescript = devDependencies.typescript || '^5.5.4';
        devDependencies['@types/react'] = devDependencies['@types/react'] || '^18.3.3';
        devDependencies['@types/react-dom'] = devDependencies['@types/react-dom'] || '^18.3.0';

        return {
          ...parsed,
          name: (parsed.name || data.appName || 'localship-app').toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
          private: true,
          main: 'main.js',
          scripts: {
            ...(parsed.scripts || {}),
            dev: parsed.scripts?.dev || 'vite',
            'build:web': parsed.scripts?.['build:web'] || 'vite build',
            start: parsed.scripts?.start || 'electron .',
            dist: parsed.scripts?.dist || 'npm run build:web && electron-builder'
          },
          dependencies,
          devDependencies
        };
      };

      const compileCssForBuild = async () => {
        const cssInput = projectFiles['input.css'] || '@tailwind base;\n@tailwind components;\n@tailwind utilities;';
        const content = Object.entries(projectFiles).map(([filename, code]) => ({
          raw: code,
          extension: filename.split('.').pop()
        }));
        let userConfig = { content: ["./**/*.{js,ts,jsx,tsx,html}"] };
        const configCode = projectFiles['tailwind.config.js'] || '';
        try {
          const configMatch = configCode.match(/module\.exports\s*=\s*(\{[\s\S]*\})/);
          if (configMatch) {
            userConfig = Function(`"use strict"; return (${configMatch[1]})`)();
          }
        } catch (e) {
          log("Tailwind config parse failed during build; using default.");
        }
        userConfig.content = content;
        const result = await postcss([tailwindcss(userConfig), autoprefixer]).process(cssInput, { from: undefined });
        return result.css;
      };

      const ensureCssImport = (entryFile) => {
        const importTarget = '__localship.generated.css';
        const entryDir = path.dirname(entryFile);
        const relative = path.relative(entryDir, importTarget).replace(/\\/g, '/');
        const importPath = relative.startsWith('.') ? relative : `./${relative}`;
        const source = projectFiles[entryFile] || '';
        if (source.includes(importTarget)) return;
        projectFiles[entryFile] = `import '${importPath}';\n${source}`;
      };

      let entry = resolveEntry();
      if (!entry) {
        projectFiles['App.tsx'] = projectFiles['App.tsx'] || `import React from 'react';
const App: React.FC = () => <div style={{ padding: 24 }}>LocalShip App</div>;
export default App;`;
        projectFiles['index.tsx'] = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);`;
        entry = 'index.tsx';
      }

      ensureIndexHtml(entry);
      ensureBuildConfig();
      projectFiles['__localship.generated.css'] = await compileCssForBuild();
      ensureCssImport(entry);

      for (const [filename, content] of Object.entries(projectFiles)) {
        writeFile(filename, content);
      }

      writeFile('main.js', data.mainJs || '');
      writeFile('preload.js', data.preloadJs || '');
      writeFile('package.json', JSON.stringify(parsePackage(), null, 2));
      writeFile('README.md', data.readme || '');

      if (data.iconBuffer) {
        const buildDir = path.join(buildRoot, 'build');
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, 'icon.png'), Buffer.from(data.iconBuffer));
      }

      log("Installing dependencies...");
      await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--silent']);

      log("Building web assets...");
      await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '--base', './']);
      normalizeDistAssetPaths();
      const distIndexPath = path.join(buildRoot, 'dist', 'index.html');
      if (!fs.existsSync(distIndexPath)) {
        throw new Error('Web build validation failed: dist/index.html missing.');
      }
      const distIndex = fs.readFileSync(distIndexPath, 'utf-8');
      if (!/id=["']root["']/.test(distIndex) || !/<script/i.test(distIndex)) {
        throw new Error('Web build validation failed: dist/index.html missing root/script wiring.');
      }

      outputDir = data.outputDir || path.join(buildRoot, 'release');
      const config = {
        appId: "com.localship.app",
        productName: data.appName,
        directories: { output: outputDir },
        files: ["dist/**/*", "main.js", "preload.js", "package.json"],
        mac: { target: ["dmg"], category: "public.app-category.developer-tools" },
        win: { target: "nsis" },
        linux: { target: "AppImage" },
        asar: true
      };
      if (data.iconBuffer) {
        config.mac.icon = "build/icon.png";
        config.win.icon = "build/icon.png";
        config.linux.icon = "build/icon.png";
      }
      fs.writeFileSync(path.join(buildRoot, 'electron-builder.json'), JSON.stringify(config, null, 2), 'utf-8');

      log("Running electron-builder...");
      const platform = data.targetPlatform || '';
      const args = ['electron-builder', '--config', 'electron-builder.json'];
      if (platform.startsWith('mac')) {
        args.push('--mac');
        if (platform.includes('arm')) args.push('--arm64');
        if (platform.includes('intel')) args.push('--x64');
      } else if (platform === 'windows') {
        args.push('--win');
      } else if (platform === 'linux') {
        args.push('--linux');
      }

      await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', args);

      const removed = cleanupArtifacts(outputDir, data.targetPlatform);
      if (removed.length > 0) {
        log(`Cleaned extra artifacts: ${removed.join(', ')}`);
      }
      const artifacts = findArtifacts(outputDir);
      const primaryArtifact = selectPrimaryArtifact(artifacts, data.targetPlatform);
      if (!primaryArtifact) {
        throw new Error('Build completed but no installable artifact was found.');
      }
      log(`Build complete. Output: ${outputDir}`);
      return {
        success: true,
        path: outputDir,
        primaryArtifact,
        artifacts
      };
    } catch (e) {
      const resolvedOutputDir = outputDir || data?.outputDir || null;
      const artifacts = resolvedOutputDir ? findArtifacts(resolvedOutputDir) : [];
      if (artifacts.length > 0) {
        const primaryArtifact = selectPrimaryArtifact(artifacts, data?.targetPlatform);
        const warning = `Builder reported an error, but artifacts were produced: ${artifacts.map(p => path.basename(p)).join(', ')}`;
        err(`Build warning: ${e.message}`);
        log(`Build warning: ${warning}`);
        return {
          success: true,
          path: resolvedOutputDir || undefined,
          warning: `${e.message}. ${warning}`,
          primaryArtifact: primaryArtifact || undefined,
          artifacts
        };
      }
      err(`Build failed: ${e.message}`);
      return { success: false, error: e.message };
    }
});
