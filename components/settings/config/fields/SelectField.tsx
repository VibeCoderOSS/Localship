import React from 'react';
import { FieldOption } from '../types';

interface SelectFieldProps {
  id: string;
  label: string;
  value: string;
  options: FieldOption[];
  help?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

const SelectField: React.FC<SelectFieldProps> = ({
  id,
  label,
  value,
  options,
  help,
  disabled,
  onChange
}) => {
  return (
    <div className="bg-slate-50 dark:bg-ocean-950/50 p-3 rounded-lg border border-slate-200 dark:border-ocean-700/50">
      <label htmlFor={id} className="block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-2">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full bg-white dark:bg-ocean-900 border border-slate-300 dark:border-ocean-700 rounded-lg px-3 py-2 text-xs text-slate-700 dark:text-slate-200 disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {help && <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">{help}</p>}
    </div>
  );
};

export default SelectField;
