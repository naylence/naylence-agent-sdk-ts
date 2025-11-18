/**
 * Naylence Agent SDK plugin entry point for the naylence-factory plugin ecosystem.
 */
import type { FamePlugin } from '@naylence/factory';
import { VERSION } from './version.js';

let initialized = false;

const agentSdkPlugin: FamePlugin = {
  name: 'naylence:agent-sdk',
  version: VERSION,
  async register(): Promise<void> {
    if (initialized) {
      return;
    }

    initialized = true;

    // The agent SDK primarily provides types, base classes, and utilities.
    // It doesn't register factories like the runtime package does.
    // The side-effect import of agent-proxy-default.js in index.ts
    // handles the default agent proxy registration.
  },
};

export default agentSdkPlugin;

export const AGENT_SDK_PLUGIN_SPECIFIER = agentSdkPlugin.name;
