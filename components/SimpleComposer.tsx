import React, { useMemo, useState } from 'react';
import { SimpleComposerDraft, SimpleComposerPayload } from '../types';
import { canSubmitSimpleDraft, composeSimplePrompt, normalizeSimpleDraft, SIMPLE_NOTES_MAX_CHARS } from '../utils/promptComposer';

interface SimpleComposerProps {
  draft: SimpleComposerDraft;
  askInput: string;
  isIterationContext: boolean;
  isLoading: boolean;
  isConfigured: boolean;
  actionMode: 'ask' | 'build';
  onDraftChange: (next: SimpleComposerDraft) => void;
  onAskInputChange: (value: string) => void;
  onSubmit: (payload: SimpleComposerPayload) => void;
  onActionModeChange: (mode: 'ask' | 'build') => void;
}

interface SuggestionPreset {
  label: string;
  draft: SimpleComposerDraft;
}

const SUGGESTIONS: SuggestionPreset[] = [
  {
    label: 'Local bakery landing page',
    draft: {
      goal: 'Build a polished landing page for a local bakery.',
      style: 'Warm, friendly, modern',
      mustHave: 'Menu section, testimonials, booking form',
      notes: 'Make it responsive and conversion-focused.'
    }
  },
  {
    label: 'Productivity dashboard',
    draft: {
      goal: 'Create a productivity dashboard web app.',
      style: 'Clean and professional',
      mustHave: 'Tasks panel, calendar panel, responsive layout',
      notes: 'Prioritize readability and clear hierarchy.'
    }
  },
  {
    label: 'Retro arcade game',
    draft: {
      goal: 'Code a retro arcade game with smooth controls and score tracking.',
      style: 'Retro arcade look',
      mustHave: 'Start/restart flow and score system',
      notes: 'Ensure mobile-friendly controls.'
    }
  },
  {
    label: '3D rotating cube',
    draft: {
      goal: 'Build a 3D scene with a rotating cube.',
      style: 'Minimal and modern',
      mustHave: "Use local three.js import only, no CDN",
      notes: 'Keep performance stable and include basic camera + lighting.'
    }
  }
];

const SimpleComposer: React.FC<SimpleComposerProps> = ({
  draft,
  askInput,
  isIterationContext,
  isLoading,
  isConfigured,
  actionMode,
  onDraftChange,
  onAskInputChange,
  onSubmit,
  onActionModeChange
}) => {
  const [showPreview, setShowPreview] = useState(false);
  const [presetNotice, setPresetNotice] = useState('');
  const [isGuidedOpen, setIsGuidedOpen] = useState(true);

  const normalizedDraft = useMemo(() => normalizeSimpleDraft(draft), [draft]);
  const normalizedAsk = askInput.trim();
  const buildLabel = isIterationContext ? 'Change/Improve' : 'Make';
  const submitDisabled = isLoading || !isConfigured || (actionMode === 'ask' ? normalizedAsk.length === 0 : !canSubmitSimpleDraft(normalizedDraft));
  const notesLength = (normalizedDraft.notes || '').length;
  const previewText = composeSimplePrompt(
    actionMode === 'ask'
      ? { mode: 'ask', goal: normalizedAsk }
      : { ...normalizedDraft, mode: isIterationContext ? 'iterate' : 'build' }
  );

  const triggerSubmit = () => {
    if (submitDisabled) return;
    if (actionMode === 'ask') {
      onSubmit({
        mode: 'ask',
        goal: normalizedAsk
      });
    } else {
      onSubmit({ ...normalizedDraft, mode: isIterationContext ? 'iterate' : 'build' });
    }
    setIsGuidedOpen(false);
  };

  const updateField = (key: keyof SimpleComposerDraft, value: string) => {
    onDraftChange({ ...draft, [key]: value });
    if (presetNotice) setPresetNotice('');
  };

  const applyPreset = (preset: SuggestionPreset) => {
    onDraftChange({ ...preset.draft });
    setPresetNotice(`Preset applied: ${preset.label}`);
  };

  const clearForm = () => {
    onDraftChange({ goal: '', style: '', mustHave: '', notes: '' });
    onAskInputChange('');
    setPresetNotice('');
  };

  const submitOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      triggerSubmit();
    }
  };

  const submitNotesShortcut = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      triggerSubmit();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onActionModeChange('build')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase rounded-lg border transition ${actionMode === 'build' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-ocean-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-ocean-700'}`}
          >
            {buildLabel}
          </button>
          <button
            type="button"
            onClick={() => onActionModeChange('ask')}
            className={`px-3 py-1.5 text-[11px] font-bold uppercase rounded-lg border transition ${actionMode === 'ask' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-ocean-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-ocean-700'}`}
          >
            Ask
          </button>
        </div>
        <button
          type="button"
          onClick={() => setIsGuidedOpen((prev) => !prev)}
          className="px-2.5 py-1 text-[10px] rounded-md border border-slate-300 dark:border-ocean-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-ocean-800 uppercase tracking-widest font-bold"
        >
          {isGuidedOpen ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {isGuidedOpen ? (
        <>
          {actionMode === 'ask' ? (
            <div className="grid grid-cols-1 gap-2">
              <input
                value={askInput}
                onChange={(e) => {
                  onAskInputChange(e.target.value);
                  if (presetNotice) setPresetNotice('');
                }}
                onKeyDown={submitOnEnter}
                placeholder="Ask about the current app or the next best step."
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-700 rounded-lg px-3 py-2 text-xs"
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              <input
                value={draft.goal || ''}
                onChange={(e) => updateField('goal', e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={isIterationContext ? "What should I change or improve?" : "What should I build?"}
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-700 rounded-lg px-3 py-2 text-xs"
              />
              <input
                value={draft.style || ''}
                onChange={(e) => updateField('style', e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={isIterationContext ? "Any style direction to keep or adjust? (optional)" : "What style should it have? (optional)"}
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-700 rounded-lg px-3 py-2 text-xs"
              />
              <input
                value={draft.mustHave || ''}
                onChange={(e) => updateField('mustHave', e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={isIterationContext ? "What must stay or be added? (optional)" : "What must it include? (optional)"}
                className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-700 rounded-lg px-3 py-2 text-xs"
              />
              <div>
                <textarea
                  value={draft.notes || ''}
                  onChange={(e) => updateField('notes', e.target.value.slice(0, SIMPLE_NOTES_MAX_CHARS))}
                  onKeyDown={submitNotesShortcut}
                  placeholder={isIterationContext ? "Extra constraints or context (optional). Use Cmd/Ctrl+Enter to submit." : "Extra notes (optional). Use Cmd/Ctrl+Enter to submit."}
                  className="w-full bg-slate-50 dark:bg-ocean-950 border border-slate-200 dark:border-ocean-700 rounded-lg px-3 py-2 text-xs resize-none h-20"
                />
                <div className={`text-[10px] mt-1 ${notesLength > SIMPLE_NOTES_MAX_CHARS * 0.9 ? 'text-amber-600' : 'text-slate-500'}`}>
                  {notesLength}/{SIMPLE_NOTES_MAX_CHARS}
                </div>
              </div>
            </div>
          )}

          {actionMode === 'build' && !isIterationContext && (
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="px-2.5 py-1 text-[10px] rounded-full border border-slate-300 dark:border-ocean-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-ocean-800"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}

          {actionMode === 'build' && !isIterationContext && presetNotice && (
            <div className="text-[10px] text-blue-600 dark:text-blue-300">{presetNotice}</div>
          )}

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={clearForm}
              className="text-[10px] uppercase tracking-widest font-bold text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
            >
              Clear Form
            </button>
            <button
              type="button"
              onClick={() => setShowPreview((prev) => !prev)}
              className="text-[10px] uppercase tracking-widest font-bold text-blue-600 dark:text-blue-300"
            >
              {showPreview ? 'Hide Prompt Preview' : 'Show Prompt Preview'}
            </button>
          </div>

          {showPreview && (
            <pre className="p-3 rounded-lg border border-slate-200 dark:border-ocean-700 bg-slate-50 dark:bg-ocean-950 text-[10px] whitespace-pre-wrap font-mono text-slate-600 dark:text-slate-300">
              {previewText}
            </pre>
          )}
        </>
      ) : (
        <div className="p-3 rounded-lg border border-slate-200 dark:border-ocean-700 bg-slate-50 dark:bg-ocean-950 text-[10px] text-slate-600 dark:text-slate-300 space-y-1">
          {actionMode === 'ask' ? (
            <div><span className="font-bold">Ask:</span> {normalizedAsk || 'Not set'}</div>
          ) : (
            <>
              <div><span className="font-bold">{isIterationContext ? 'Change request' : 'Goal'}:</span> {normalizedDraft.goal || 'Not set'}</div>
              {normalizedDraft.style && <div><span className="font-bold">Style:</span> {normalizedDraft.style}</div>}
              {normalizedDraft.mustHave && <div><span className="font-bold">Must-have:</span> {normalizedDraft.mustHave}</div>}
              {normalizedDraft.notes && <div><span className="font-bold">Notes:</span> {normalizedDraft.notes}</div>}
            </>
          )}
        </div>
      )}

      {actionMode === 'ask' && !normalizedAsk && (
        <div className="text-[10px] text-amber-600">
          Please enter your question to continue.
        </div>
      )}
      {actionMode === 'build' && !normalizedDraft.goal && (
        <div className="text-[10px] text-amber-600">
          {isIterationContext ? 'Please enter what should change or improve.' : 'Please enter a goal to continue.'}
        </div>
      )}

      <div className="flex justify-between items-center">
        <p className="text-[10px] text-slate-500">
          {actionMode === 'ask' ? "We'll answer without modifying files." : (isIterationContext ? "We'll update your current app from these inputs." : "We'll build this from your form inputs.")}
        </p>
        <button
          onClick={triggerSubmit}
          disabled={submitDisabled}
          className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 rounded-lg text-white text-[11px] font-bold uppercase tracking-widest shadow-lg active:scale-95 transition-all"
        >
          {isLoading ? 'Running...' : (actionMode === 'ask' ? 'Ask' : (isIterationContext ? 'Apply Change' : 'Make'))}
        </button>
      </div>
    </div>
  );
};

export default SimpleComposer;
