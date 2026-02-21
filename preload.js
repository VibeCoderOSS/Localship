
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  buildApp: (data) => ipcRenderer.invoke('build-app', data),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  compileTailwind: (data) => ipcRenderer.invoke('compile-tailwind', data),
  initProject: (data) => ipcRenderer.invoke('project-init', data),
  validateProjectDir: (data) => ipcRenderer.invoke('project-validate', data),
  importProject: (data) => ipcRenderer.invoke('project-import', data),
  saveWorkspace: (data) => ipcRenderer.invoke('project-save-workspace', data),
  loadWorkspace: (data) => ipcRenderer.invoke('project-load-workspace', data),
  listVersions: (data) => ipcRenderer.invoke('project-list-versions', data),
  saveVersion: (data) => ipcRenderer.invoke('project-save-version', data),
  loadVersion: (data) => ipcRenderer.invoke('project-load-version', data),
  onBuildLog: (callback) => ipcRenderer.on('build-log', (_event, value) => callback(value)),
  onBuildError: (callback) => ipcRenderer.on('build-error', (_event, value) => callback(value)),
  removeListeners: () => {
    ipcRenderer.removeAllListeners('build-log');
    ipcRenderer.removeAllListeners('build-error');
  }
});
