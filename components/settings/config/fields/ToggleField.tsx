import React from 'react';

interface ToggleFieldProps {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

const ToggleField: React.FC<ToggleFieldProps> = ({
  id,
  label,
  help,
  checked,
  disabled,
  onChange
}) => {
  return (
    <div className="flex items-center justify-between bg-slate-50 dark:bg-ocean-950/50 p-3 rounded-lg border border-slate-200 dark:border-ocean-700/50">
      <div className="pr-3">
        <label htmlFor={id} className="block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
          {label}
        </label>
        {help && <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">{help}</p>}
      </div>
      <div className="relative inline-block w-10 mr-1 align-middle select-none">
        <input
          type="checkbox"
          id={id}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer transition-all duration-300 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            right: checked ? '0' : '50%',
            borderColor: checked ? '#3b82f6' : '#cbd5e1'
          }}
        />
        <label
          htmlFor={id}
          className={`toggle-label block overflow-hidden h-5 rounded-full transition-colors duration-300 ${checked ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        />
      </div>
    </div>
  );
};

export default ToggleField;
