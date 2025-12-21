/**
 * Isomorphic entry point for Naylence Agent SDK.
 *
 * Exports utilities, agent base classes, and cross-platform helpers that
 * do not rely on Node.js-only dependencies. This file purposefully excludes
 * node-only modules such as the HTTP gateway listener.
 */

// Agent core exports (all browser-safe)
export * from './naylence/agent/a2a-types.js';
export * from './naylence/agent/agent.js';
export * from './naylence/agent/base-agent.js';
export * from './naylence/agent/background-task-agent.js';
export { AgentProxy } from './naylence/agent/agent-proxy.js';
export * from './naylence/agent/errors.js';
export * from './naylence/agent/rpc-adapter.js';
export * from './naylence/agent/util.js';
export * from './naylence/agent/configs.js';
export * from './naylence/agent/util/register-agent-factories.js';

// Register default agent proxy factory (side-effect)
import './naylence/agent/agent-proxy-default.js';
