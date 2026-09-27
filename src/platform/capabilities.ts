/** 运行能力检测：任何一项缺失都显示 UNSUPPORTED（不降级、不假装可用）。 */
export interface Capabilities {
  supported: boolean;
  missing: string[];
}

export function detectCapabilities(w: Window = window): Capabilities {
  const missing: string[] = [];

  if (!('serviceWorker' in w.navigator)) missing.push('Service Worker');
  if (typeof w.isSecureContext === 'boolean' && !w.isSecureContext) missing.push('安全上下文');
  if (typeof w.caches?.keys !== 'function') missing.push('Cache Storage');
  if (!('indexedDB' in w) || typeof w.indexedDB?.open !== 'function') missing.push('IndexedDB');
  if (!w.crypto?.subtle || typeof w.crypto.subtle.digest !== 'function') {
    missing.push('Web Crypto (SHA-256)');
  }
  if (typeof globalThis.AbortController !== 'function') missing.push('AbortController');
  if (typeof w.fetch !== 'function') missing.push('Fetch');
  if (typeof globalThis.TextEncoder !== 'function') missing.push('TextEncoder');
  // 多标签页一致性依赖：跨页面安装互斥与状态广播。
  if (typeof w.navigator.locks?.request !== 'function') missing.push('Web Locks');
  if (typeof globalThis.BroadcastChannel !== 'function') missing.push('BroadcastChannel');

  return { supported: missing.length === 0, missing };
}
