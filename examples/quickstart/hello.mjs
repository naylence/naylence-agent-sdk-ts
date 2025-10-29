import { withFabric, enableLogging, LogLevel } from "@naylence/runtime";
import { Agent, BaseAgent } from "@naylence/agent-sdk";

enableLogging(LogLevel.WARNING);

class EchoAgent extends BaseAgent {
    async runTask(payload) {
        return payload;
    }
}

async function main() {
    await withFabric(async (fabric) => {
        const agentAddress = await fabric.serve(new EchoAgent());
        console.log(`Agent is listening at address: ${agentAddress}`);
        const remoteAgent = Agent.remoteByAddress(agentAddress);
        const result = await remoteAgent.runTask("Hello, World!");
        console.log(result);
    });
}

main().catch((error) => {
    console.error("quickstart example failed", error);
    process.exitCode = 1;
});
