/**
 * Node.js entry point for Naylence Agent SDK.
 *
 * Includes all isomorphic exports plus Node.js-specific components
 * like the HTTP gateway listener which depends on Fastify.
 */
import '@naylence/runtime';
import plugin from './plugin.js';

// Always register the plugin directly. This ensures it is initialized even if
// the dynamic import mechanism (used by FAME_PLUGINS) fails.
(async () => {
  try {
    await plugin.register();
  } catch (err) {
    console.error('[naylence-agent-sdk] Failed to auto-register plugin:', err);
  }
})();

// Auto-register the agent-sdk plugin in FAME_PLUGINS for child processes
if (typeof process !== 'undefined' && process.env) {
  const pluginName = '@naylence/agent-sdk';
  const current = process.env.FAME_PLUGINS || '';
  const plugins = current.split(',').map((p) => p.trim());
  if (!plugins.includes(pluginName)) {
    process.env.FAME_PLUGINS = current
      ? `${current},${pluginName}`
      : pluginName;
  }
}

// Re-export all isomorphic components
export * from './agent-isomorphic.js';

// Node-only exports: HTTP Gateway Listener
export * from './naylence/agent/gateway/agent-http-gateway-listener.js';
export * from './naylence/agent/gateway/agent-http-gateway-listener-factory.js';

// Export plugin as default for naylence-factory plugin system
export { default } from './plugin.js';
