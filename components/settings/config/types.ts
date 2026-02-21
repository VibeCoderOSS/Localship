import { AppConfig } from '../../../types';

export type SettingsTabId = 'basics' | 'model' | 'runtime' | 'export' | 'developer';

export type SettingsFieldKey =
  | keyof AppConfig
  | 'modelTierOverride'
  | 'projectDir';

export type SettingsControlType =
  | 'input'
  | 'number'
  | 'select'
  | 'toggle'
  | 'readonly'
  | 'model'
  | 'tier-override'
  | 'folder-picker';

export interface SettingsIssue {
  severity: 'error' | 'warning';
  message: string;
  field: SettingsFieldKey | 'global';
}

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldSpec {
  key: SettingsFieldKey;
  tab: SettingsTabId;
  controlType: SettingsControlType;
  label: string;
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: FieldOption[];
  visibleIf?: (config: AppConfig, isElectron: boolean) => boolean;
  disabledIf?: (config: AppConfig) => boolean;
}

export interface SectionSpec {
  tab: SettingsTabId;
  title: string;
  description?: string;
  fields: SettingsFieldKey[];
}
