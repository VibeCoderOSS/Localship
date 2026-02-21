import React from 'react';

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({ title, description, children }) => {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wide">{title}</h3>
        {description && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">{description}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
};

export default SettingsSection;
