# Naylence Agent SDK (TypeScript)

> 🚧 **Work in progress.** This package is the TypeScript port of the Naylence Agent SDK. The initial commit lays down the build tooling, testing harness, and project structure so we can begin migrating features from the Python implementation.

## Goals

- Provide a cross-platform agent orchestration toolkit that mirrors the Python SDK feature set.
- Integrate cleanly with the Naylence Fame runtime, factories, and core protocol packages.
- Offer typed APIs, cancellable async task helpers, and structured logging aligned with the Naylence platform conventions.

## Repository Layout

```
src/
  index.ts          # Primary library entry point (re-exports agent modules)
  browser.ts        # Browser-friendly bundle entry
  naylence/agent/   # Feature modules (placeholders for now)

__tests__/          # Jest tests (populate during feature porting)
test/setup.ts       # Shared Jest setup hook
```

## Development Scripts

All commands are defined in `package.json`:

- `npm run build` – Clean, type-check, and emit CJS/ESM/UMD bundles.
- `npm test` – Run the Jest suite with `ts-jest` in ESM mode.
- `npm run lint` / `npm run lint:fix` – ESLint with TypeScript rules.
- `npm run format` – Prettier formatting helpers.
- `npm run dev` – ESM compile-on-save loop for rapid development.

> **Tip:** Run `npm install` inside `naylence-agent-sdk-ts` before executing any scripts. The project expects Node.js 18+.

## Configuration helpers

The SDK now ships with `CLIENT_CONFIG`, `NODE_CONFIG`, and `SENTINEL_CONFIG` objects under `naylence/agent/configs`. These mirror the Python defaults and keep environment placeholder strings such as `${env:FAME_STORAGE_PROFILE:memory}` so you can hydrate values the same way across runtimes. Import them via:

```ts
import { CLIENT_CONFIG, NODE_CONFIG, SENTINEL_CONFIG } from "naylence-agent-sdk/naylence/agent/configs";
```

## Quickstart example

The `examples/quickstart/hello.mjs` script demonstrates serving a minimal `BaseAgent` implementation and invoking it through a remote proxy. Run it after installing dependencies (the `FAME_PLUGINS` variable enables the in-memory runtime used by the script):

```bash
npm install
FAME_PLUGINS=naylence-runtime node examples/quickstart/hello.mjs
```

The example spins up an in-process `FameFabric`, serves an `EchoAgent` that overrides `runTask`, obtains a proxy via `Agent.remoteByAddress`, and prints the response returned by `runTask`.

## API naming

The TypeScript SDK exposes camelCase APIs such as `runTask`, `startTask`, `subscribeToTaskUpdates`, and `remoteByAddress`. Snake_case variants have been fully removed—update any callers that still rely on `run_task`-style helpers to use the camelCase equivalents.

## Next Steps

- Port agent abstractions (`BaseAgent`, `BackgroundTaskAgent`, etc.) from the Python SDK.
- Add integration glue with the runtime, factory, and core packages.
- Flesh out unit and integration tests that mirror the Python coverage.

## License

Licensed under the [Apache 2.0](./LICENSE) license. See the NOTICE file in the root repository for attribution details.
