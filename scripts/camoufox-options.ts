import { launchOptions } from 'camoufox-js';
import { installedVerStr } from 'camoufox-js/dist/pkgman.js';

// beta.34 removed these overrides. Drop only these legacy writes while
// preserving the library's fingerprint generation and config validation.
export function compatibleConfig(version: string): Record<string, unknown> {
  const removed = new Set(version === '156.0.1-beta.34' ? [
    'navigator.product', 'navigator.appCodeName', 'navigator.appName', 'window.history.length',
    'canvas:aaOffset', 'canvas:aaCapOffset',
  ] : []);
  return new Proxy<Record<string, unknown>>({}, {
    set(target, key, value) {
      if (typeof key === 'string' && removed.has(key)) return true;
      return Reflect.set(target, key, value);
    },
  });
}
export function browserOptions(locale: string) {
  return launchOptions({headless:false,geoip:false,locale,config:compatibleConfig(installedVerStr())});
}
