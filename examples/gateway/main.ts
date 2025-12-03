import { Registry as FactoryRegistry } from '@naylence/factory';
import { TRANSPORT_LISTENER_FACTORY_BASE_TYPE, withFabric } from '@naylence/runtime/node';
import {
  BaseAgent,
  AgentHttpGatewayListenerFactory,
  FACTORY_META as GATEWAY_FACTORY_META,
  ensureAgentFactoriesRegistered,
} from '@naylence/agent-sdk';
import { GATEWAY_CONFIG } from './config.js';
import { AGENT_ADDR } from './common.js';

class EchoAgent extends BaseAgent {
  async runTask(payload: any): Promise<any> {
    return payload;
  }
}

async function main(): Promise<void> {
  // Ensure gateway transport factory is registered before starting the fabric.
  FactoryRegistry.registerFactory(
    TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
    GATEWAY_FACTORY_META.key,
    AgentHttpGatewayListenerFactory,
    GATEWAY_FACTORY_META
  );
  FactoryRegistry.registerFactory(
    `naylence.${TRANSPORT_LISTENER_FACTORY_BASE_TYPE}`,
    GATEWAY_FACTORY_META.key,
    AgentHttpGatewayListenerFactory,
    GATEWAY_FACTORY_META
  );
  // await ensureAgentFactoriesRegistered();

  // Spin up a Sentinel node with the Agent HTTP Gateway listener and a simple echo agent.
  await withFabric({ rootConfig: GATEWAY_CONFIG }, async () => {
    const agent = new EchoAgent();
    await agent.aserve(AGENT_ADDR);

    const port = GATEWAY_CONFIG.node.listeners.find((l) => l.type === 'AgentHttpGatewayListener')?.port ?? 8080;
    const baseUrl = GATEWAY_CONFIG.node.public_url ?? `http://localhost:${port}`;

    console.log('[gateway] HTTP gateway ready');
    console.log('  RPC endpoint:     POST', `${baseUrl}/fame/v1/gateway/rpc`);
    console.log('  Messages endpoint: POST', `${baseUrl}/fame/v1/gateway/messages`);
    console.log('  Echo agent address:', AGENT_ADDR);

    // Keep the process alive.
    await new Promise(() => undefined);
  });
}

main().catch((error) => {
  console.error('[gateway] failed to start:', error);
  process.exit(1);
});
