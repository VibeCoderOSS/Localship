import React, { useEffect, useMemo, useState } from 'react';
import { ProjectDetails, TargetPlatform } from '../types';

interface BuildModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialDetails: ProjectDetails;
  initialTargetPlatform: TargetPlatform;
  initialOutputDir?: string;
  onBuild: (details: ProjectDetails, targetPlatform: TargetPlatform, outputDir?: string) => Promise<void> | void;
}

const BuildModal: React.FC<BuildModalProps> = ({
  isOpen,
  onClose,
  initialDetails,
  initialTargetPlatform,
  initialOutputDir,
  onBuild
}) => {
  const [localDetails, setLocalDetails] = useState<ProjectDetails>(initialDetails);
  const [targetPlatform, setTargetPlatform] = useState<TargetPlatform>(initialTargetPlatform);
  const [outputDir, setOutputDir] = useState<string>(initialOutputDir || '');
  const [isBuilding, setIsBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setLocalDetails(initialDetails);
      setTargetPlatform(initialTargetPlatform);
      setOutputDir(initialOutputDir || '');
      setError(null);
      setIsBuilding(false);
    }
  }, [isOpen, initialDetails, initialTargetPlatform, initialOutputDir]);

  const iconUrl = useMemo(() => {
    if (!localDetails.icon) return '';
    return URL.createObjectURL(localDetails.icon);
  }, [localDetails.icon]);

  useEffect(() => {
    return () => {
      if (iconUrl) URL.revokeObjectURL(iconUrl);
    };
  }, [iconUrl]);

  const handleSelectOutput = async () => {
    if (!window.electronAPI) return;
    const path = await window.electronAPI.selectDirectory();
    if (path) setOutputDir(path);
  };

  const handleBuild = async () => {
    if (!localDetails.name.trim()) {
      setError("App name is required.");
      return;
    }
    setIsBuilding(true);
    setError(null);
    try {
      await onBuild(localDetails, targetPlatform, outputDir || undefined);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Build failed.");
    } finally {
      setIsBuilding(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-200/60 dark:bg-slate-900/50 backdrop-blur-sm p-6">
      <div className="bg-white dark:bg-ocean-900 border border-slate-200 dark:border-ocean-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-ocean-700 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">Build Native App</h3>
            <p className="text-[10px] text-slate-400">Generate DMG / EXE / AppImage</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-white">✕</button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-3 gap-4 items-center">
            <div className="col-span-2">
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">App Name</label>
              <input
                type="text"
                value={localDetails.name}
                onChange={(e) => setLocalDetails(prev => ({ ...prev, name: e.target.value }))}
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                placeholder="My App"
              />
            </div>
            <div className="flex flex-col items-center gap-2">
              <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-ocean-800 border border-slate-200 dark:border-ocean-700 overflow-hidden flex items-center justify-center">
                {iconUrl ? (
                  <img src={iconUrl} alt="App icon" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-xl">🚀</span>
                )}
              </div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 cursor-pointer">
                Choose Icon
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    setLocalDetails(prev => ({ ...prev, icon: file }));
                  }}
                />
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Author</label>
            <input
              type="text"
              value={localDetails.author}
              onChange={(e) => setLocalDetails(prev => ({ ...prev, author: e.target.value }))}
              className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              placeholder="Your name"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Target Platform</label>
            <select
              value={targetPlatform}
              onChange={(e) => setTargetPlatform(e.target.value as TargetPlatform)}
              className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
            >
              <option value="mac-arm64">macOS (Apple Silicon/M1/M2/M3) - .dmg</option>
              <option value="mac-intel">macOS (Intel Legacy) - .dmg</option>
              <option value="windows">Windows - .exe</option>
              <option value="linux">Linux - .AppImage</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Output Folder</label>
            <div className="flex gap-2">
              <input
                type="text"
                readOnly
                value={outputDir}
                placeholder="Default (Downloads Folder)"
                className="flex-1 bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white focus:outline-none text-sm"
              />
              <button
                onClick={handleSelectOutput}
                className="px-4 py-2 bg-slate-200 dark:bg-ocean-800 hover:bg-slate-300 dark:hover:bg-ocean-700 text-slate-700 dark:text-slate-200 rounded-lg text-sm font-medium transition-colors"
              >
                Select Folder
              </button>
            </div>
          </div>

          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-ocean-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
            disabled={isBuilding}
          >
            Cancel
          </button>
          <button
            onClick={handleBuild}
            disabled={isBuilding}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold tracking-wide shadow-lg transition-transform active:scale-95 disabled:opacity-50"
          >
            {isBuilding ? 'Building...' : 'Build App'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BuildModal;
