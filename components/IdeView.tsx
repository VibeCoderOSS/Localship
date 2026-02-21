
import React, { useState, useEffect } from 'react';
import { ProjectFiles } from '../types';

interface IdeViewProps {
  files: ProjectFiles;
  onUpdateFile: (filename: string, content: string) => void;
}

const IdeView: React.FC<IdeViewProps> = ({ files, onUpdateFile }) => {
  const filenames = Object.keys(files).sort();
  // Default to index.html or first available
  const [activeFile, setActiveFile] = useState<string>(filenames.includes('index.html') ? 'index.html' : filenames[0] || '');
  const [editorContent, setEditorContent] = useState('');

  useEffect(() => {
    if (activeFile && files[activeFile] !== undefined) {
      setEditorContent(files[activeFile]);
    }
  }, [activeFile, files]);

  const handleEditorChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setEditorContent(newContent);
    onUpdateFile(activeFile, newContent);
  };

  return (
    <div className="flex w-full h-full bg-slate-50 dark:bg-[#1e1e1e] text-slate-700 dark:text-slate-300 font-mono text-sm overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
      
      {/* Sidebar: File Tree */}
      <div className="w-48 flex-shrink-0 bg-white dark:bg-[#252526] border-r border-slate-200 dark:border-slate-700 flex flex-col">
        <div className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-500 border-b border-slate-200 dark:border-slate-700">
          Explorer
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {filenames.map(name => (
            <button
              key={name}
              onClick={() => setActiveFile(name)}
              className={`w-full text-left px-4 py-1.5 hover:bg-slate-100 dark:hover:bg-[#2a2d2e] flex items-center gap-2 truncate ${
                activeFile === name ? 'bg-slate-200 text-slate-900 dark:bg-[#37373d] dark:text-white' : ''
              }`}
            >
              <span className={`w-3 h-3 rounded-full ${
                name.endsWith('.html') ? 'bg-orange-500' :
                name.endsWith('.css') ? 'bg-blue-400' :
                name.endsWith('.js') ? 'bg-yellow-400' : 'bg-slate-500'
              }`}></span>
              {name}
            </button>
          ))}
          {filenames.length === 0 && (
             <div className="px-4 py-2 text-slate-500 italic">No files</div>
          )}
        </div>
      </div>

      {/* Main: Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Editor Tabs (Visual Only for now) */}
        {activeFile && (
           <div className="bg-slate-50 dark:bg-[#1e1e1e] border-b border-slate-200 dark:border-slate-700 flex">
             <div className="px-4 py-2 bg-slate-50 dark:bg-[#1e1e1e] text-slate-900 dark:text-white border-t-2 border-blue-500 flex items-center gap-2">
               {activeFile}
             </div>
           </div>
        )}

        <div className="flex-1 relative">
           {activeFile ? (
             <textarea
               className="w-full h-full bg-white dark:bg-[#1e1e1e] text-slate-900 dark:text-[#d4d4d4] p-4 outline-none resize-none font-mono leading-relaxed"
               value={editorContent}
               onChange={handleEditorChange}
               spellCheck={false}
             />
           ) : (
             <div className="flex items-center justify-center h-full text-slate-500">
               Select a file to edit
             </div>
           )}
        </div>
      </div>
    </div>
  );
};

export default IdeView;
