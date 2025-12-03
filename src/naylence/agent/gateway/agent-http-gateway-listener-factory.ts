import {
  AuthorizerFactory,
  TransportListenerFactory as BaseTransportListenerFactory,
  TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  safeImport,
  type Authorizer,
  type HttpServer,
  type NodeEventListener,
  type TransportListener,
  type TransportListenerConfig,
} from '@naylence/runtime/node';
import type { AgentHttpGatewayListener } from './agent-http-gateway-listener.js';

export interface AgentHttpGatewayListenerFactoryConfig extends TransportListenerConfig {
  type: 'AgentHttpGatewayListener';
  basePath?: string;
  authorizer?: Record<string, unknown> | null;
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
}

let defaultHttpServerModulePromise!: Promise<{ DefaultHttpServer: any }>;
function getDefaultHttpServerModule(): Promise<{ DefaultHttpServer: any }> {
  if (!defaultHttpServerModulePromise) {
    defaultHttpServerModulePromise = safeImport(
      async () => {
        const mod = await import('@naylence/runtime/node');
        return { DefaultHttpServer: mod.DefaultHttpServer };
      },
      '@fastify/websocket'
    );
  }
  return defaultHttpServerModulePromise;
}

let gatewayListenerModulePromise!: Promise<{ AgentHttpGatewayListener: typeof AgentHttpGatewayListener }>;
function getGatewayListenerModule(): Promise<{ AgentHttpGatewayListener: typeof AgentHttpGatewayListener }> {
  if (!gatewayListenerModulePromise) {
    gatewayListenerModulePromise = safeImport(
      () => import('./agent-http-gateway-listener.js'),
      'fastify'
    );
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

  return {
    type: 'AgentHttpGatewayListener',
    host: hostValue,
    port: portValue,
    basePath: basePathValue,
    authorizer: authorizerValue,
  };
}

export const FACTORY_META = {
  base: TRANSPORT_LISTENER_FACTORY_BASE_TYPE,
  key: 'AgentHttpGatewayListener',
} as const;

export class AgentHttpGatewayListenerFactory extends BaseTransportListenerFactory<AgentHttpGatewayListenerFactoryConfig> {
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
      authorizer =
        (await AuthorizerFactory.createAuthorizer(normalized.authorizer, {
          validate: false,
        })) ?? null;
    }

    return new AgentHttpGatewayListener({
      httpServer,
      basePath: normalized.basePath,
      ...(authorizer ? { authorizer } : {}),
    });
  }

  private async _createDefaultHttpServer(normalized: NormalizedConfig): Promise<HttpServer> {
    const { DefaultHttpServer } = await getDefaultHttpServerModule();
    return await DefaultHttpServer.getOrCreate({
      host: normalized.host,
      port: normalized.port,
    });
  }
}

export default AgentHttpGatewayListenerFactory;
