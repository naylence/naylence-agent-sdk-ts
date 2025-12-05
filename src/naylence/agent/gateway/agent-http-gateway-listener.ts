import { FameResponseType, type AuthorizationContext, type CreateFameEnvelopeOptions } from '@naylence/core';
import {
  QueueFullError,
  TransportListener,
  createNodeDeliveryContext,
  type Authorizer,
  type HttpRouter,
  type HttpServer,
  type NodeLike,
} from '@naylence/runtime/node';
import { getLogger } from '@naylence/runtime';

const DEFAULT_BASE_PATH = '/fame/v1/gateway';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

const logger = getLogger('naylence.agent.gateway.http_listener');

type RpcRequest =
  | {
      targetAddr: string;
      method: string;
      params?: Record<string, any>;
      timeoutMs?: number;
    }
  | {
      capabilities: string[];
      method: string;
      params?: Record<string, any>;
      timeoutMs?: number;
    };

type MessageRequest =
  | { targetAddr: string; type?: string; payload?: any }
  | { capabilities: string[]; type?: string; payload?: any };

export class AgentHttpGatewayListener extends TransportListener {
  private readonly _httpServer: HttpServer;
  private readonly _authorizer: Authorizer | null;
  private readonly _basePath: string;
  private _node: NodeLike | null = null;
  private _routerRegistered = false;

  constructor(params: { httpServer: HttpServer; basePath?: string; authorizer?: Authorizer | null }) {
    super();
    this._httpServer = params.httpServer;
    this._authorizer = params.authorizer ?? null;
    this._basePath = sanitizeBasePath(params.basePath);
  }

  get httpServer(): HttpServer {
    return this._httpServer;
  }

  async onNodeInitialized(node: NodeLike): Promise<void> {
    if (this._routerRegistered) {
      return;
    }

    this._node = node;
    const router = await this.createRouter();
    await this._httpServer.includeRouter(router, { prefix: this._basePath });
    this._routerRegistered = true;
  }

  async onNodeStarted(): Promise<void> {
    if (this._httpServer.isRunning) {
      return;
    }
    await this._httpServer.start();
  }

  async onNodeStopped(): Promise<void> {
    this._routerRegistered = false;
    this._node = null;
    const candidate = this._httpServer as any;
    if (candidate?.constructor?.release) {
      try {
        await candidate.constructor.release({
          host: candidate.host,
          port: candidate.port,
        });
      } catch {
        // Best-effort cleanup; ignore failures to avoid masking stop errors.
      }
    }
  }

  async createRouter(): Promise<HttpRouter> {
    const plugin: HttpRouter = async (instance: any) => {
      instance.post('/rpc', async (request: any, reply: any) =>
        this._handleRpc(request.body, request.headers['authorization'], reply)
      );
      instance.post('/messages', async (request: any, reply: any) =>
        this._handleMessage(request.body, request.headers['authorization'], reply)
      );
      instance.get('/health', async () => ({
        status: 'healthy',
        listenerType: 'AgentHttpGatewayListener',
      }));
    };

    return plugin;
  }

  private async _handleRpc(body: unknown, authHeader: unknown, reply: any): Promise<any> {
    const node = this._node;
    if (!node) {
      return reply.code(503).send({ ok: false, error: 'Node not initialized' });
    }

    try {
      const request = this._parseRpcRequest(body);
      if (!request) {
        return reply.code(400).send({ ok: false, error: 'Invalid RPC request body' });
      }

      const authorization = await this._authenticateRequest(authHeader);
      logger.debug('rpc_request_authenticated', {
        hasAuthorization: Boolean(authorization),
        principal: authorization?.principal ?? null,
        scopes: authorization?.grantedScopes ?? [],
      });
      const timeoutMs = this._normalizeTimeout(request.timeoutMs);
      const result = await this._invokeRpc(node, request, timeoutMs);
      return reply.code(200).send({ ok: true, result });
    } catch (error) {
      const mapped = this._mapError(error);
      return reply.code(mapped.status).send({
        ok: false,
        error: mapped.message,
        ...(mapped.code ? { code: mapped.code } : {}),
      });
    }
  }

  private async _handleMessage(body: unknown, authHeader: unknown, reply: any): Promise<any> {
    const node = this._node;
    if (!node) {
      return reply.code(503).send({ ok: false, error: 'Node not initialized' });
    }

    try {
      const request = this._parseMessageRequest(body);
      if (!request) {
        return reply.code(400).send({ ok: false, error: 'Invalid message request body' });
      }

      const authorization = await this._authenticateRequest(authHeader);
      logger.debug('message_request_authenticated', {
        hasAuthorization: Boolean(authorization),
        principal: authorization?.principal ?? null,
        scopes: authorization?.grantedScopes ?? [],
      });
      await this._sendMessage(node, request, authorization);
      return reply.code(202).send({ status: 'message_accepted' });
    } catch (error) {
      const mapped = this._mapError(error);
      return reply.code(mapped.status).send({
        ok: false,
        error: mapped.message,
        ...(mapped.code ? { code: mapped.code } : {}),
      });
    }
  }

  private _parseRpcRequest(body: unknown): RpcRequest | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const record = body as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method.trim() : '';
    if (!method) {
      return null;
    }

    const timeoutMs = this._parseTimeoutValue(record.timeoutMs);
    const params =
      record.params && typeof record.params === 'object' && !Array.isArray(record.params)
        ? (record.params as Record<string, any>)
        : undefined;

    const targetAddr = typeof record.targetAddr === 'string' ? record.targetAddr.trim() : '';
    const capsRaw = Array.isArray(record.capabilities)
      ? (record.capabilities as unknown[]).map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
      : [];

    if (targetAddr) {
      return {
        targetAddr,
        method,
        ...(params ? { params } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }

    if (capsRaw.length > 0) {
      return {
        capabilities: capsRaw,
        method,
        ...(params ? { params } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }

    return null;
  }

  private _parseMessageRequest(body: unknown): MessageRequest | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }

    const record = body as Record<string, unknown>;
    const targetAddr = typeof record.targetAddr === 'string' ? record.targetAddr.trim() : '';
    const capsRaw = Array.isArray(record.capabilities)
      ? (record.capabilities as unknown[]).map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
      : [];

    const type = typeof record.type === 'string' ? record.type.trim() : '';
    const payload = 'payload' in record ? (record as { payload: any }).payload : undefined;

    if (!type && payload === undefined) {
      return null;
    }

    if (targetAddr) {
      return { targetAddr, ...(type ? { type } : {}), ...(payload !== undefined ? { payload } : {}) };
    }

    if (capsRaw.length > 0) {
      return { capabilities: capsRaw, ...(type ? { type } : {}), ...(payload !== undefined ? { payload } : {}) };
    }

    return null;
  }

  private _parseTimeoutValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private _normalizeTimeout(value: number | undefined): number {
    if (value === undefined || Number.isNaN(value)) {
      return DEFAULT_TIMEOUT_MS;
    }
    if (value <= 0) {
      return DEFAULT_TIMEOUT_MS;
    }
    return Math.min(value, MAX_TIMEOUT_MS);
  }

  private async _invokeRpc(
    node: NodeLike,
    request: RpcRequest,
    timeoutMs: number
  ): Promise<any> {
    const timeout = this._normalizeTimeout(timeoutMs);
    if ('targetAddr' in request) {
      return node.invoke(request.targetAddr, request.method, request.params ?? {}, timeout);
    }
    return node.invokeByCapability(request.capabilities, request.method, request.params ?? {}, timeout);
  }

  private async _sendMessage(
    node: NodeLike,
    request: MessageRequest,
    authorization: AuthorizationContext | undefined
  ): Promise<void> {
    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame: {
        type: 'Data',
        payload: {
          ...(request.type ? { type: request.type } : {}),
          ...(request.payload !== undefined ? { payload: request.payload } : {}),
        },
      },
      responseType: FameResponseType.NONE,
    };

    if ('targetAddr' in request) {
      envelopeOptions.to = request.targetAddr;
    } else {
      envelopeOptions.capabilities = request.capabilities;
    }

    const envelope = node.envelopeFactory.createEnvelope(envelopeOptions);
    const context = createNodeDeliveryContext({
      authorization: authorization ?? undefined,
    });
    await node.send(envelope, context);
  }

  private async _authenticateRequest(header: unknown): Promise<AuthorizationContext | undefined> {
    const authorizer = await this._resolveAuthorizer();
    if (!authorizer) {
      return undefined;
    }

    const token = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : '';
    try {
      const result = await authorizer.authenticate(token ?? '');
      if (!result) {
        throw new Error('Authentication failed');
      }
      return result;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
  }

  private async _resolveAuthorizer(): Promise<Authorizer | undefined> {
    if (this._authorizer) {
      return this._authorizer;
    }

    const node = this._node;
    const securityManager = node?.securityManager ?? null;
    return securityManager?.authorizer ?? undefined;
  }

  private _mapError(error: unknown): { status: number; message: string; code?: string } {
    if (error instanceof QueueFullError) {
      return { status: 429, message: 'receiver busy', code: 'queue_full' };
    }

    if (error instanceof Error) {
      const message = error.message || 'Internal server error';
      const normalized = message.toLowerCase();
      if (normalized.includes('authentication failed')) {
        return { status: 401, message, code: 'unauthorized' };
      }
      if (normalized.includes('forbidden') || normalized.includes('not authorized')) {
        return { status: 403, message, code: 'forbidden' };
      }
      if (normalized.includes('timeout')) {
        return { status: 504, message, code: 'timeout' };
      }
      if (normalized.includes('no route') || normalized.includes('no local handler')) {
        return { status: 404, message, code: 'not_found' };
      }
      if (normalized.includes('invalid')) {
        return { status: 400, message, code: 'invalid_request' };
      }
      return { status: 500, message };
    }

    return { status: 500, message: 'Internal server error' };
  }
}

function sanitizeBasePath(basePath?: string): string {
  if (!basePath || typeof basePath !== 'string') {
    return DEFAULT_BASE_PATH;
  }
  const trimmed = basePath.trim();
  if (!trimmed.startsWith('/')) {
    return `/${trimmed}`;
  }
  return trimmed || DEFAULT_BASE_PATH;
}
