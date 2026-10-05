import type { Settings } from '../types/common.js';

// extremely lightweight obj that can be imported/modified by any file
const settings = {} as Settings;
export default settings;

export function setSettings(new_settings: Settings): void {
  for (const key of Object.keys(settings)) {
    delete (settings as Record<string, unknown>)[key];
  }
  Object.assign(settings, new_settings);
}
