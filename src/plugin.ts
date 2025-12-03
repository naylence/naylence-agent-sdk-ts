/**
 * Naylence Agent SDK plugin entry point for the naylence-factory plugin ecosystem.
 */
import type { FamePlugin } from '@naylence/factory';
import { VERSION } from './version.js';
import { ensureAgentFactoriesRegistered } from './naylence/agent/util/register-agent-factories.js';

let initialized = false;

const agentSdkPlugin: FamePlugin = {
  name: 'naylence:agent-sdk',
  version: VERSION,
  async register(): Promise<void> {
    if (initialized) {
      return;
    }

    initialized = true;

    await ensureAgentFactoriesRegistered();
  },
};

export default agentSdkPlugin;

export const AGENT_SDK_PLUGIN_SPECIFIER = agentSdkPlugin.name;
