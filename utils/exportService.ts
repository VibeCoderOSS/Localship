
import JSZip from 'jszip';
import saveAs from 'file-saver';
import { ELECTRON_MAIN_JS, PRELOAD_JS, PACKAGE_JSON, README_MD } from '../constants';
import { ProjectDetails, BuildData, TargetPlatform, ProjectFiles } from '../types';
import { processHtmlForOffline } from './projectUtils';

// Browser-based ZIP export
export const exportProject = async (
  files: ProjectFiles, 
  details: ProjectDetails, 
  _outputDir: string | undefined, 
  _targetPlatform: TargetPlatform | undefined 
) => {
  const zip = new JSZip();
  const safeName = details.name.replace(/[^a-zA-Z0-9-_]/g, '');
  const folder = zip.folder(safeName || "LocalShipApp");

  if (!folder) return;

  // 1. The Application Logic (Write individual files)
  Object.entries(files).forEach(([filename, content]) => {
    // OFFLINE PROCESSING: Ensure HTML points to local assets instead of CDN
    if (filename.endsWith('.html')) {
      folder.file(filename, processHtmlForOffline(content));
    } else {
      folder.file(filename, content);
    }
  });

  // 2. Electron Boilerplate
  folder.file("main.js", ELECTRON_MAIN_JS);
  folder.file("package.json", PACKAGE_JSON(details.name, details.author));
  folder.file("README.md", README_MD);

  // 3. Handle Icon
  if (details.icon) {
    const buildFolder = folder.folder("build");
    if (buildFolder) {
      const iconBuffer = await details.icon.arrayBuffer();
      buildFolder.file("icon.png", iconBuffer);
    }
  }

  // 4. Generate ZIP
  const content = await zip.generateAsync({ type: "blob" });
  saveAs(content, `${safeName}-LocalShipSource.zip`);
};

// Electron-based Local Build
export const buildProjectLocally = async (
  files: ProjectFiles, 
  details: ProjectDetails,
  outputDir: string | undefined,
  targetPlatform: TargetPlatform,
  onLog: (msg: string) => void
) => {
  if (!window.electronAPI) {
    throw new Error("Not running in Electron environment.");
  }

  onLog("Preparing files for build...");

  let iconBuffer: ArrayBuffer | null = null;
  if (details.icon) {
    iconBuffer = await details.icon.arrayBuffer();
  }

  // Deep copy files to avoid mutating state directly, and apply offline processing
  const processedFiles: ProjectFiles = {};
  Object.entries(files).forEach(([filename, content]) => {
     if (filename.endsWith('.html')) {
       processedFiles[filename] = processHtmlForOffline(content);
     } else {
       processedFiles[filename] = content;
     }
  });

  const buildData: BuildData = {
    appName: details.name,
    files: processedFiles, 
    mainJs: ELECTRON_MAIN_JS,
    preloadJs: PRELOAD_JS,
    packageJson: PACKAGE_JSON(details.name, details.author),
    readme: README_MD,
    iconBuffer: iconBuffer,
    outputDir: outputDir, 
    targetPlatform: targetPlatform
  };

  // Set up listeners for streaming logs from main process
  window.electronAPI.removeListeners();
  
  window.electronAPI.onBuildLog((msg) => {
    onLog(msg);
  });

  window.electronAPI.onBuildError((msg) => {
    onLog(`❌ ${msg}`);
  });

  onLog("Sending data to main process...");
  const result = await window.electronAPI.buildApp(buildData);

  if (!result) {
    throw new Error("Build process returned no result. The main process may not be implemented.");
  }

  // CRITICAL: Check the result returned from the main process
  if (!result.success) {
    throw new Error(result.error || "Build process failed (check logs above).");
  }

  if (!result.primaryArtifact) {
    throw new Error("Build reported success but no installable artifact was produced.");
  }

  onLog(`✅ Primary artifact: ${result.primaryArtifact}`);
  if (Array.isArray(result.artifacts) && result.artifacts.length > 1) {
    onLog(`ℹ️ Additional artifacts: ${result.artifacts.join(', ')}`);
  }

  if (result.warning) {
    onLog(`⚠️ ${result.warning}`);
  }
};
