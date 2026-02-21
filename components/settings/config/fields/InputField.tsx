import React from 'react';

interface InputFieldProps {
  id: string;
  label: string;
  value: string;
  help?: string;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  mono?: boolean;
  onChange?: (value: string) => void;
}

const InputField: React.FC<InputFieldProps> = ({
  id,
  label,
  value,
  help,
  placeholder,
  readOnly,
  disabled,
  mono,
  onChange
}) => {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2 uppercase tracking-wide">
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-slate-50 dark:bg-ocean-950 border border-slate-300 dark:border-ocean-700 rounded-lg px-4 py-2.5 text-slate-800 dark:text-white outline-none text-sm placeholder-slate-400 dark:placeholder-slate-600 ${mono ? 'font-mono' : ''} ${disabled ? 'opacity-50' : ''}`}
      />
      {help && <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">{help}</p>}
    </div>
  );
};

export default InputField;
