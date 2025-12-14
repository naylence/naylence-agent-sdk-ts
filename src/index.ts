// Auto-register the agent-sdk plugin if we are in a Node.js environment or browser with shim
import '@naylence/runtime';
import plugin from './plugin.js';

// Always register the plugin directly. This ensures it is initialized even if
// the dynamic import mechanism (used by FAME_PLUGINS) fails, which is common in
// browser bundlers (Vite/Webpack) for bare specifiers.
(async () => {
  try {
    await plugin.register();
  } catch (err) {
    console.error('[naylence-agent-sdk] Failed to auto-register plugin:', err);
  }
})();

const g = (typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : {}) as any;
const proc = g.process || (typeof process !== 'undefined' ? process : undefined);
const isNode =
  typeof process !== 'undefined' &&
  process.versions != null &&
  process.versions.node != null;

// Only in Node.js: populate FAME_PLUGINS so child processes inherit it.
// In the browser, we rely on the direct registration above.
if (isNode && proc && proc.env) {
  const pluginName = '@naylence/agent-sdk';
  const current = proc.env.FAME_PLUGINS || '';
  const plugins = current.split(',').map((p: string) => p.trim());
  if (!plugins.includes(pluginName)) {
    proc.env.FAME_PLUGINS = current
      ? `${current},${pluginName}`
      : pluginName;
  }
}

export * from './naylence/agent/index.js';

// Export plugin as default for naylence-factory plugin system
export { default } from './plugin.js';
