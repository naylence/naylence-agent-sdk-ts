import type { FameAddress, FameFabric } from 'naylence-runtime';
import type { Agent, AgentProxyContract } from './agent.js';

export interface AgentProxyConstructor<TAgent extends Agent> {
  remoteByAddress(
    address: FameAddress,
    options: { fabric: FameFabric }
  ): AgentProxyContract<TAgent>;
  remoteByCapabilities(
    capabilities: string[],
    options: { fabric: FameFabric }
  ): AgentProxyContract<TAgent>;
}

let registeredAgentProxyCtor: AgentProxyConstructor<Agent> | null = null;

export function registerAgentProxyFactory<TAgent extends Agent>(
  factory: AgentProxyConstructor<TAgent>
): void {
  registeredAgentProxyCtor = factory as AgentProxyConstructor<Agent>;
}

export function resolveAgentProxyCtor<TAgent extends Agent>(): AgentProxyConstructor<TAgent> {
  if (!registeredAgentProxyCtor) {
    throw new Error(
      'AgentProxy factory has not been registered; import `naylence/agent/agent-proxy.js` or register a custom implementation.'
    );
  }

  return registeredAgentProxyCtor as AgentProxyConstructor<TAgent>;
}
