import React, { useEffect, useState } from 'react';

interface ProjectSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (data: { mode: 'new' | 'import'; name: string; baseDir?: string; existingDir?: string }) => void;
  initialMode?: 'new' | 'import';
  initialName?: string;
  initialBaseDir?: string;
  initialExistingDir?: string;
}

const ProjectSetupModal: React.FC<ProjectSetupModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  initialMode,
  initialName,
  initialBaseDir,
  initialExistingDir
}) => {
  const [mode, setMode] = useState<'new' | 'import'>('new');
  const [name, setName] = useState('');
  const [baseDir, setBaseDir] = useState('');
  const [existingDir, setExistingDir] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setMode(initialMode || 'new');
      setName(initialName || name || 'LocalShip Project');
      setBaseDir(initialBaseDir || '');
      setExistingDir(initialExistingDir || '');
    }
  }, [isOpen, initialMode, initialName, initialBaseDir, initialExistingDir]);

  const handlePickDir = async () => {
    if (!window.electronAPI) return;
    const dir = await window.electronAPI.selectDirectory();
    if (dir) setBaseDir(dir);
  };

  const handleConfirm = () => {
    if (mode === 'new') {
      if (!name.trim()) {
        setError("Project name is required.");
        return;
      }
      if (!baseDir.trim()) {
        setError("Please choose a project folder.");
        return;
      }
      onConfirm({ mode: 'new', name: name.trim(), baseDir: baseDir.trim() });
      return;
    }

    if (!existingDir.trim()) {
      setError("Please choose an existing project folder.");
      return;
    }
    const derivedName = name.trim() || existingDir.split('/').filter(Boolean).pop() || 'Imported Project';
    onConfirm({ mode: 'import', name: derivedName, existingDir: existingDir.trim() });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-200/60 dark:bg-slate-900/50 backdrop-blur-sm p-6">
      <div className="bg-white dark:bg-ocean-900 border border-slate-200 dark:border-ocean-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-ocean-700 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">Project Setup</h3>
            <p className="text-[10px] text-slate-400">Choose a name and storage folder</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-white">✕</button>
        </div>

        <div className="p-6 space-y-5">
          <div className="flex gap-2 bg-slate-100 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-700 rounded-xl p-1">
            <button
              onClick={() => { setMode('new'); setError(null); }}
              className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-colors ${mode === 'new' ? 'bg-blue-600 text-white shadow' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}
            >
              New Project
            </button>
            <button
              onClick={() => { setMode('import'); setError(null); }}
              className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg transition-colors ${mode === 'import' ? 'bg-blue-600 text-white shadow' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400'}`}
            >
              Import Existing
            </button>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              placeholder="LocalShip Project"
            />
          </div>

          {mode === 'new' ? (
            <div>
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Project Folder</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={baseDir}
                  placeholder="Select a folder..."
                  className="flex-1 bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white focus:outline-none text-sm"
                />
                <button
                  onClick={handlePickDir}
                  className="px-4 py-2 bg-slate-200 dark:bg-ocean-800 hover:bg-slate-300 dark:hover:bg-ocean-700 text-slate-700 dark:text-slate-200 rounded-lg text-sm font-medium transition-colors"
                >
                  Choose
                </button>
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">Existing Project Folder</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={existingDir}
                  placeholder="Select a project folder..."
                  className="flex-1 bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white focus:outline-none text-sm"
                />
                <button
                  onClick={async () => {
                    const dir = await window.electronAPI?.selectDirectory();
                    if (dir) {
                      setExistingDir(dir);
                      if (!name.trim()) {
                        const derived = dir.split('/').filter(Boolean).pop() || 'Imported Project';
                        setName(derived);
                      }
                    }
                  }}
                  className="px-4 py-2 bg-slate-200 dark:bg-ocean-800 hover:bg-slate-300 dark:hover:bg-ocean-700 text-slate-700 dark:text-slate-200 rounded-lg text-sm font-medium transition-colors"
                >
                  Choose
                </button>
              </div>
            </div>
          )}

          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>

        <div className="px-6 py-4 border-t border-slate-200 dark:border-ocean-700 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold tracking-wide shadow-lg transition-transform active:scale-95"
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProjectSetupModal;
