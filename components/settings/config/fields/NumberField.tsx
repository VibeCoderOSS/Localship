import React from 'react';

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

const NumberField: React.FC<NumberFieldProps> = ({
  id,
  label,
  value,
  help,
  min,
  max,
  step,
  disabled,
  onChange
}) => {
  return (
    <div className="bg-slate-50 dark:bg-ocean-950/50 p-3 rounded-lg border border-slate-200 dark:border-ocean-700/50">
      <label htmlFor={id} className="block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wide mb-2">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full bg-white dark:bg-ocean-900 border border-slate-300 dark:border-ocean-700 rounded-lg px-3 py-2 text-xs text-slate-700 dark:text-slate-200 disabled:opacity-50"
      />
      {help && <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">{help}</p>}
    </div>
  );
};

export default NumberField;
