import { withFabric } from "@naylence/runtime";
import { BaseAgent } from "@naylence/agent-sdk";
import { AGENT_ADDR } from "./common.js";
import { GATEWAY_CONFIG } from "./config.js";

class EchoAgent extends BaseAgent {
  async runTask(payload: any): Promise<any> {
    return payload;
  }
}

async function main() {
  await withFabric({ rootConfig: GATEWAY_CONFIG }, async () => {
    await new EchoAgent().aserve(AGENT_ADDR);
  });
}

// Start the agent when this module is run directly
main().catch((error) => {
  console.error("Echo agent failed:", error);
  process.exit(1);
});
