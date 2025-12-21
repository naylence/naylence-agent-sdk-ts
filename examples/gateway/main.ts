import { withFabric } from '@naylence/core';
import { GATEWAY_CONFIG } from './config.js';
import { AGENT_ADDR } from './common.js';
import { MathAgent } from './math-agent.js';


async function main(): Promise<void> {
  await withFabric({ rootConfig: GATEWAY_CONFIG }, async () => {
    const agent = new MathAgent();
    await agent.aserve(AGENT_ADDR);

    // Keep the process alive.
    await new Promise(() => undefined);
  });
}

main().catch((error) => {
  console.error('[gateway] failed to start:', error);
  process.exit(1);
});
