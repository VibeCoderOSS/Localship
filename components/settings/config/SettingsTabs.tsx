import React from 'react';
import { SettingsTabId } from './types';

interface TabItem {
  id: SettingsTabId;
  label: string;
}

interface SettingsTabsProps {
  tabs: TabItem[];
  activeTab: SettingsTabId;
  onChange: (tab: SettingsTabId) => void;
}

const SettingsTabs: React.FC<SettingsTabsProps> = ({ tabs, activeTab, onChange }) => {
  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`px-3 py-1.5 text-[11px] font-bold uppercase rounded-lg border transition ${activeTab === tab.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-ocean-900 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-ocean-700'}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};

export default SettingsTabs;
