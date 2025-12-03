/**
 * Minimal factory manifest for agent-sdk factories.
 */
export const MODULES = ['./gateway/agent-http-gateway-listener-factory.js'];

export const MODULE_LOADERS: Record<string, () => Promise<unknown>> = {
  './gateway/agent-http-gateway-listener-factory.js': () =>
    import(/* webpackIgnore: true */ /* @vite-ignore */ './gateway/agent-http-gateway-listener-factory.js'),
};
