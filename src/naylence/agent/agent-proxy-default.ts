import { registerAgentProxyFactory } from './agent-proxy-registry.js';
import { AgentProxy } from './agent-proxy.js';

registerAgentProxyFactory({
  remoteByAddress: AgentProxy.remoteByAddress,
  remoteByCapabilities: AgentProxy.remoteByCapabilities,
});
