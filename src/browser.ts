/**
 * Browser entry point for Naylence Agent SDK.
 *
 * Re-exports isomorphic components and registers the plugin in browser environments.
 * Does NOT include Node.js-specific components like the HTTP gateway listener.
 */
import '@naylence/runtime';
import plugin from './plugin.js';

// Auto-register the plugin in browser environments
(async () => {
  try {
    await plugin.register();
  } catch (err) {
    console.error('[naylence-agent-sdk] Failed to auto-register plugin:', err);
  }
})();

// Re-export all isomorphic components
export * from './agent-isomorphic.js';

// Export plugin as default for naylence-factory plugin system
export { default } from './plugin.js';
