/**
 * Factory for creating AgentHttpGatewayListener instances.
 *
 * This file is Node.js-only but is structured to avoid static value imports from
 * @naylence/runtime/node so that bundlers don't fail when analyzing the module graph.
 * Type imports are safe (erased at compile time). Actual runtime values are loaded dynamically.
 */

// Type-only imports are safe for bundlers (erased at compile time)
import type { AgentHttpGatewayListener, GatewayLimits } from './agent-http-gateway-listener.js';
import type {
  Authorizer,
  HttpServer,
  NodeEventListener,
  TransportListener,
  TransportListenerConfig,
} from '@naylence/runtime/node';

// Factory base type constant - matches @naylence/runtime value
const TRANSPORT_LISTENER_FACTORY_BASE_TYPE = 'TransportListenerFactory';

export interface AgentHttpGatewayListenerFactoryConfig extends TransportListenerConfig {
  type: 'AgentHttpGatewayListener';
  basePath?: string;
  authorizer?: Record<string, unknown> | null;
  /** Structural limits for routing/envelope fields */
  limits?: GatewayLimits;
}

export interface CreateAgentHttpGatewayListenerOptions {
  httpServer?: HttpServer;
  authorizer?: Authorizer | null;
}

interface NormalizedConfig {
  type: 'AgentHttpGatewayListener';
  host: string;
  port: number;
  basePath: string;
  authorizer: Record<string, unknown> | null;
  limits: GatewayLimits | null;
}

// Cached module promises for lazy loading
let runtimeNodeModulePromise: Promise<any> | null = null;

/**
 * Dynamically load @naylence/runtime/node module.
 * Uses dynamic import with @vite-ignore to prevent bundler from following this path.
 */
async function getRuntimeNodeModule(): Promise<any> {
  if (!runtimeNodeModulePromise) {
    // Dynamic import with @vite-ignore to prevent bundler from following this path
    runtimeNodeModulePromise = import(/* webpackIgnore: true */ /* @vite-ignore */ '@naylence/runtime/node');
  }
  return runtimeNodeModulePromise;
}

let gatewayListenerModulePromise: Promise<{ AgentHttpGatewayListener: typeof AgentHttpGatewayListener }> | null = null;

async function getGatewayListenerModule(): Promise<{ AgentHttpGatewayListener: typeof AgentHttpGatewayListener }> {
  if (!gatewayListenerModulePromise) {
    // Dynamic import with @vite-ignore to prevent bundler from following this path
    gatewayListenerModulePromise = import(/* webpackIgnore: true */ /* @vite-ignore */ './agent-http-gateway-listener.js');
  }
  return gatewayListenerModulePromise;
}

function addServerEventListener(server: HttpServer | null | undefined, listeners: NodeEventListener[]): void {
  if (!server || !Array.isArray(listeners)) {
    return;
  }
  const candidate = server as unknown;
  if (!candidate || typeof candidate !== 'object') {
    return;
  }
  const listener = candidate as NodeEventListener;
  if (typeof listener.priority === 'number' && !listeners.includes(listener)) {
    listeners.push(listener);
  }
}

function normalizeConfig(config?: AgentHttpGatewayListenerFactoryConfig | Record<string, unknown> | null): NormalizedConfig {
  const record = (config ?? {}) as Record<string, unknown>;
  const hostValue =
    typeof record.host === 'string' && record.host.trim().length > 0 ? record.host.trim() : '0.0.0.0';
  const rawPort = record.port;
  let portValue = 0;
  if (typeof rawPort === 'number' && Number.isFinite(rawPort)) {
    portValue = rawPort;
  } else if (typeof rawPort === 'string') {
    const parsed = Number.parseInt(rawPort.trim(), 10);
    if (Number.isFinite(parsed)) {
      portValue = parsed;
    }
  }

  const basePathValue =
    typeof record.basePath === 'string' && record.basePath.trim().length > 0
      ? record.basePath.trim()
      : '/fame/v1/gateway';

  const rawAuthorizer = record.authorizer ?? null;
  const authorizerValue =
    rawAuthorizer && typeof rawAuthorizer === 'object' && !Array.isArray(rawAuthorizer)
      ? (rawAuthorizer as Record<string, unknown>)
      : null;

  const rawLimits = record.limits ?? null;
  const limitsValue =
    rawLimits && typeof rawLimits === 'object' && !Array.isArray(rawLimits)
      ? (rawLimits as GatewayLimits)
      : null;

  return {
    type: 'AgentHttpGatewayListener',
    host: hostValue,
    port: portValue,
    basePath: basePathValue,
    authorizer: authorizerValue,
    limits: limitsValue,
  };
}

export const FACTORY_META = {
  base: TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  key: 'AgentHttpGatewayListener',
} as const;

/**
 * Factory for creating AgentHttpGatewayListener instances.
 *
 * This factory does not extend BaseTransportListenerFactory to avoid static imports
 * from @naylence/runtime/node. Instead, it implements the factory interface directly.
 */
export class AgentHttpGatewayListenerFactory {
  readonly type = 'AgentHttpGatewayListener';
  readonly priority = 1000;

  async create(
    config?: AgentHttpGatewayListenerFactoryConfig | Record<string, unknown> | null,
    ...factoryArgs: unknown[]
  ): Promise<TransportListener> {
    const normalized = normalizeConfig(config);
    const [firstArg, ...remainingArgs] = factoryArgs;
    const eventListeners = Array.isArray(firstArg) ? (firstArg as NodeEventListener[]) : [];
    const optionsSource = Array.isArray(firstArg) ? (remainingArgs[0] ?? null) : firstArg;
    const options = optionsSource as CreateAgentHttpGatewayListenerOptions | null;

    const { AgentHttpGatewayListener } = await getGatewayListenerModule();
    const httpServer = options?.httpServer ?? (await this._createDefaultHttpServer(normalized));
    addServerEventListener(httpServer, eventListeners);

    let authorizer = options?.authorizer ?? null;
    if (!authorizer && normalized.authorizer) {
      const runtimeNode = await getRuntimeNodeModule();
      const AuthorizerFactory = runtimeNode.AuthorizerFactory;
      authorizer =
        (await AuthorizerFactory.createAuthorizer(normalized.authorizer, {
          validate: false,
        })) ?? null;
    }

    return new AgentHttpGatewayListener({
      httpServer,
      basePath: normalized.basePath,
      ...(authorizer ? { authorizer } : {}),
      ...(normalized.limits ? { limits: normalized.limits } : {}),
    });
  }

  private async _createDefaultHttpServer(normalized: NormalizedConfig): Promise<HttpServer> {
    const runtimeNode = await getRuntimeNodeModule();
    const DefaultHttpServer = runtimeNode.DefaultHttpServer;
    return await DefaultHttpServer.getOrCreate({
      host: normalized.host,
      port: normalized.port,
    });
  }
}

export default AgentHttpGatewayListenerFactory;
