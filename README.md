[![Join our Discord](https://img.shields.io/badge/Discord-Join%20Chat-blue?logo=discord)](https://discord.gg/nwZAeqdv7y)

# Naylence Agent SDK (TypeScript)

The **Naylence Agent SDK** is the official toolkit for building agents and clients on the Naylence Agentic Fabric. It gives you a clean, typed, async-first API for composing tasks, streaming results, and wiring agents together—locally or across a distributed fabric.

> If you're new to Naylence, start here. For lower‑level transport/fabric internals, see **@naylence/runtime**.

---

## Highlights

* **Ergonomic agent model** — subclass `BaseAgent` (one-shot) or `BackgroundTaskAgent` (long‑running/streaming) and focus on your logic.
* **Typed messages & tasks** — Zod models for `Task`, `Message`, `Artifact`, and JSON‑RPC A2A operations.
* **Async all the way** — non‑blocking lifecycle with easy scatter‑gather helpers (`Agent.broadcast`, `Agent.runMany`).
* **Remote proxies** — call agents by **address** or **capabilities** via `Agent.remote*` helpers.
* **Streaming & cancellation** — subscribe to live status/artifacts; cancel in‑flight work.
* **FastAPI integration** — drop‐in JSON‑RPC router (`createAgentRouter`) and `/agent.json` metadata endpoint.
* **Security ready** — works with runtime security profiles; **strict‑overlay** requires the `@naylence/advanced‑security` add‑on.

---

## Install

```bash
npm install @naylence/agent-sdk
```

> Node.js **18+** is required.

---

## Quickstart (minimal)

```javascript
import { withFabric } from '@naylence/runtime';
import { Agent, BaseAgent } from '@naylence/agent-sdk';

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
    const result = await remoteAgent.runTask('Hello, World!');
    console.log(result);
  });
}

main().catch((error) => {
  console.error('quickstart example failed', error);
  process.exitCode = 1;
});
```

For a gentle, runnable tour—from single‑process to distributed orchestration—use the **Examples** repo: [https://github.com/naylence/naylence-examples-ts](https://github.com/naylence/naylence-examples-ts).

---

## Core concepts

**Agents & tasks**

* Implement `runTask(payload, id)` for simple one‑shot work, or override `startTask(...)`/`getTaskStatus(...)` for background jobs.
* `Message.parts` carries either text (`TextPart`) or structured data (`DataPart`).
* Long‑running flows stream `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` until terminal (`COMPLETED`/`FAILED`/`CANCELED`).

**Remote proxies**

* `Agent.remoteByAddress("echo@fame.fabric")` to call a known address.
* `Agent.remoteByCapabilities(["agent"])` to call by capability (fabric does resolution).

**Streaming & cancel**

* `subscribeToTaskUpdates(...)` yields status/artifacts live.
* `cancelTask(...)` requests cooperative cancellation when supported by the agent.

**RPC operations**

* A2A JSON‑RPC methods (`tasks/send`, `.../get`, `.../cancel`, etc.) are provided for task lifecycle.
* Custom functions can be exposed via the RPC mixin in the underlying fabric (e.g., streaming operations).

**FastAPI router**

* Use `createAgentRouter(agent)` to expose a JSON‑RPC endpoint (default: `/fame/v1/jsonrpc`) and `GET /agent.json` to return an `AgentCard`.

---

## Choosing an agent base class

* **`BaseAgent`** — great for synchronous/short tasks; the default fallback packages your return value into a `Task(COMPLETED)`.
* **`BackgroundTaskAgent`** — best for long‑running/streaming work. You implement `runBackgroundTask(...)`; the base manages queues, TTLs, and end‑of‑stream.

Both base classes include sensible defaults (poll‑based streaming, simple auth pass‑through). You can override any part of the lifecycle.

---

## Development workflow

* Add your agents in a project with the SDK.
* Use `FameFabric.create()` in tests or local scripts to host agents in‑process.
* For distributed setups, operate a sentinel/fabric with **@naylence/runtime** (or your infra) and connect agents remotely.
* Use the **Examples** repo ([https://github.com/naylence/naylence-examples-ts](https://github.com/naylence/naylence-examples-ts)) to learn patterns like scatter‑gather, RPC streaming, cancellation, and security tiers.

---

## Generating API Documentation

The SDK includes TypeDoc configuration to generate Markdown-based API reference documentation. The output is compatible with Nextra and other Markdown-based documentation systems.

### Generate docs locally

```bash
# Install dependencies (if not already done)
npm install

# Generate API documentation
npm run docs
```

This produces Markdown files in `docs/reference/ts/_generated/`.

### Available scripts

| Script | Description |
|--------|-------------|
| `npm run docs` | Clean and regenerate API documentation |
| `npm run docs:gen` | Generate documentation (without cleaning first) |
| `npm run docs:clean` | Remove generated documentation files |

### Documentation scope

Only the curated public API surface (exported from `src/public-api.ts`) is documented. Internal utilities and implementation details are excluded.

---

## Security notes

The SDK runs on the Naylence fabric's security profiles:

* **direct / gated / overlay** modes work out‑of‑the‑box with the open‑source stack.
* **strict‑overlay** (sealed overlay encryption + SPIFFE/X.509 identities) is available **only** with the **`@naylence/advanced‑security`** package.

See repo links below for the advanced add‑on and images that bundle it.

---

## Links

* **Agent SDK (this repo):** [https://github.com/naylence/naylence-agent-sdk-ts](https://github.com/naylence/naylence-agent-sdk-ts)
* **Examples (TypeScript):** [https://github.com/naylence/naylence-examples-ts](https://github.com/naylence/naylence-examples-ts)
* **Runtime (fabric & transports):** [https://github.com/naylence/naylence-runtime-ts](https://github.com/naylence/naylence-runtime-ts)
* **Advanced Security add‑on:** [https://github.com/naylence/naylence-advanced-security-ts](https://github.com/naylence/naylence-advanced-security-ts)

Docker images:

* OSS: `naylence/agent-sdk-node`
* Advanced: `naylence/agent-sdk-adv-node` (includes `@naylence/advanced-security`; BSL-licensed add-on)

---

## License & support

* **License:** Apache‑2.0 (SDK).&#x20;
* **Issues:** please use the appropriate GitHub repo (SDK, Runtime, Examples, Advanced Security).
