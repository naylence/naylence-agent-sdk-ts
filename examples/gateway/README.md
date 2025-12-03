# Agent HTTP Gateway example

This example runs a single Sentinel node with the Agent HTTP Gateway listener plus a tiny echo agent.

## Prereqs
- Install deps at repo root (`npm install`).
- Ensure optional peer deps for runtime HTTP listeners are installed (fastify, @fastify/websocket). These are in dev deps already.

## Run
From the repo root:

```bash
npx tsx ./examples/gateway/main.ts
```

If you `cd examples/gateway` first, run `npx tsx ./main.ts` instead.

Environment knobs (optional):
- `FAME_NODE_ID` – node id.
- `FAME_PUBLIC_URL` – public URL used in logs; defaults to `http://localhost:8080`.
- `FAME_SECURITY_PROFILE` – e.g. `open` (default).

The gateway exposes:
- `POST /fame/v1/gateway/rpc`
- `POST /fame/v1/gateway/messages`

An echo agent is bound at `echo@fame.fabric` and simply echoes payloads.
