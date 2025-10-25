import {
  FameAddress,
  FameFabric,
  basicConfig,
  fabricStack,
  generateId,
  getLogger,
  LogLevel,
} from '@naylence/runtime';
import { RpcMixin } from '@naylence/runtime';
import type { FameService } from '@naylence/core';
import type {
  AgentCard,
  AuthenticationInfo,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskSendParams,
  TaskStatusUpdateEvent,
} from './a2a-types.js';
import { resolveAgentProxyCtor } from './agent-proxy-registry.js';
export { registerAgentProxyFactory } from './agent-proxy-registry.js';
export type { AgentProxyConstructor } from './agent-proxy-registry.js';

import type { BaseAgent } from './base-agent.js';
import type { AgentProxy } from './agent-proxy.js';

const logger = getLogger('naylence.agent.agent');

export type Payload = Record<string, unknown> | string | null;
export type Targets = Iterable<readonly [FameAddress | string, Payload]>;

type AgentTaskHandler = (payload: Payload, id: string | null) => unknown | Promise<unknown>;

export type BaseAgentConstructor = new (name?: string | null, options?: any) => BaseAgent;

let registeredBaseAgentCtor: BaseAgentConstructor | null = null;

function requireBaseAgentCtor(): BaseAgentConstructor {
  if (!registeredBaseAgentCtor) {
    throw new Error('BaseAgent implementation has not been registered yet.');
  }
  return registeredBaseAgentCtor;
}

/** @internal */
export function registerBaseAgentConstructor(ctor: BaseAgentConstructor): void {
  registeredBaseAgentCtor = ctor;
}

const isNodeRuntime = (): boolean =>
  typeof process !== 'undefined' && process.release?.name === 'node';

const LOG_LEVEL_KEYWORDS: Record<string, LogLevel> = {
  critical: LogLevel.CRITICAL,
  error: LogLevel.ERROR,
  warning: LogLevel.WARNING,
  warn: LogLevel.WARNING,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
  trace: LogLevel.TRACE,
};

function normalizeLogLevel(level: string | number | LogLevel): LogLevel {
  if (typeof level === 'number') {
    if (Object.values(LogLevel).includes(level)) {
      return level as LogLevel;
    }
    throw new Error(`Unsupported numeric log level: ${level}`);
  }

  if (typeof level === 'string') {
    const keyword = level.trim().toLowerCase();
    const resolved = LOG_LEVEL_KEYWORDS[keyword];
    if (!resolved) {
      throw new Error(`Unsupported log level string: '${level}'`);
    }
    return resolved;
  }

  return level;
}

class Deferred<T = void> {
  private settled = false;
  private readonly internalResolve!: (value: T | PromiseLike<T>) => void;
  private readonly internalReject!: (reason?: unknown) => void;

  readonly promise: Promise<T>;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      (this as any).internalResolve = resolve;
      (this as any).internalReject = reject;
    });
  }

  resolve(value?: T | PromiseLike<T>): void {
    if (this.settled) return;
    this.settled = true;
    this.internalResolve(value as T | PromiseLike<T>);
  }

  reject(reason?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.internalReject(reason);
  }
}

async function setupSignalHandlers(stop: Deferred<void>): Promise<() => void> {
  if (!isNodeRuntime()) {
    return () => {};
  }

  const { default: process } = await import('node:process');
  const handler = () => stop.resolve();

  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);

  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

async function acquireFabric(options?: Record<string, unknown>): Promise<{
  fabric: FameFabric;
  release: () => Promise<void>;
}> {
  const manageContext = fabricStack.length === 0;
  const fabric = await FameFabric.getOrCreate(options ?? {});

  if (manageContext) {
    await fabric.enter();
  }

  return {
    fabric,
    release: async () => {
      if (!manageContext) {
        return;
      }
      try {
        await fabric.exit();
      } catch (error) {
        logger.warning('fabric_exit_failed', { error });
      }
    },
  };
}

function toFameAddress(value: FameAddress | string): FameAddress {
  return value instanceof FameAddress ? value : new FameAddress(String(value));
}

function invokeProxyRunTask(proxy: Agent, payload: Payload, taskId: string): Promise<any> {
  if (typeof proxy.runTask === 'function') {
    return proxy.runTask(payload, taskId);
  }
  throw new Error('AgentProxy must implement runTask');
}

export interface AgentRemoteOptions {
  address?: FameAddress | string;
  capabilities?: string[];
  fabric?: FameFabric;
}

export interface AgentRunManyOptions {
  fabric?: FameFabric;
  gatherExceptions?: boolean;
}

export interface AgentServeOptions {
  /**
   * Log level for the agent. Can be a string ('debug', 'info', 'warning', 'error', 'critical'),
   * a numeric log level, or a LogLevel enum value.
   */
  logLevel?: string | number | LogLevel | null;

  /**
   * All other options are passed directly to FameFabric.getOrCreate().
   * This matches Python's **kwargs pattern for maximum compatibility.
   *
   * Common options include:
   * - rootConfig: Root Fame configuration
   * - connectorConfig: Connector configuration
   * - securityConfig: Security configuration
   * - storageConfig: Storage configuration
   * etc.
   */
  [key: string]: unknown;
}

export abstract class Agent extends RpcMixin implements FameService {
  get capabilities(): string[] | undefined {
    return undefined;
  }

  abstract get name(): string | null;

  abstract get spec(): Record<string, unknown>;

  abstract getAgentCard(): Promise<AgentCard>;

  abstract authenticate(credentials: AuthenticationInfo): boolean;

  abstract startTask(params: TaskSendParams): Promise<Task>;

  abstract runTask(payload: Payload, id: string | null): Promise<any>;

  abstract getTaskStatus(params: TaskQueryParams): Promise<Task>;

  abstract cancelTask(params: TaskIdParams): Promise<Task>;

  abstract subscribeToTaskUpdates(
    params: TaskSendParams
  ): AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>;

  abstract unsubscribeTask(params: TaskIdParams): Promise<any>;

  abstract registerPushEndpoint(
    config: TaskPushNotificationConfig
  ): Promise<TaskPushNotificationConfig>;

  abstract getPushNotificationConfig(params: TaskIdParams): Promise<TaskPushNotificationConfig>;

  static remote<TAgent extends Agent>(
    this: typeof Agent,
    options: AgentRemoteOptions
  ): AgentProxy<TAgent> {
    const { address, capabilities, fabric } = options;
    const selected = Number(address != null) + Number(capabilities != null);

    if (selected !== 1) {
      throw new Error('Provide exactly one of address | capabilities');
    }

    const resolvedFabric = fabric ?? FameFabric.current();
    const proxyCtor = resolveAgentProxyCtor<TAgent>();

    if (address != null) {
      const addr = toFameAddress(address);
      return proxyCtor.remoteByAddress(addr, { fabric: resolvedFabric });
    }

    return proxyCtor.remoteByCapabilities(capabilities!, {
      fabric: resolvedFabric,
    });
  }

  static remoteByAddress<TAgent extends Agent>(
    this: typeof Agent,
    address: FameAddress | string,
    options: { fabric?: FameFabric } = {}
  ): AgentProxy<TAgent> {
    const remoteOptions: AgentRemoteOptions = { address };
    if (options.fabric !== undefined) {
      remoteOptions.fabric = options.fabric;
    }
    return this.remote<TAgent>(remoteOptions);
  }

  static remoteByCapabilities<TAgent extends Agent>(
    this: typeof Agent,
    capabilities: string[],
    options: { fabric?: FameFabric } = {}
  ): AgentProxy<TAgent> {
    const remoteOptions: AgentRemoteOptions = { capabilities };
    if (options.fabric !== undefined) {
      remoteOptions.fabric = options.fabric;
    }
    return this.remote<TAgent>(remoteOptions);
  }

  static async fromHandler(handler: AgentTaskHandler): Promise<Agent> {
    if (!registeredBaseAgentCtor) {
      await import('./base-agent.js');
    }
    const BaseAgentCtor = requireBaseAgentCtor();
    const normalizedHandler: AgentTaskHandler = async (payload, id) => handler(payload, id);

    class HandlerAgent extends BaseAgentCtor {
      constructor() {
        super(generateId());
      }

      async runTask(payload: Payload, id: string | null): Promise<any> {
        return normalizedHandler(payload, id);
      }
    }

    return new HandlerAgent();
  }

  static async broadcast(
    this: typeof Agent,
    addresses: Array<FameAddress | string>,
    payload: Payload = null,
    options: AgentRunManyOptions = {}
  ): Promise<Array<[string, any | Error]>> {
    const targets: Array<readonly [FameAddress | string, Payload]> = addresses.map(
      (address) => [address, payload] as const
    );
    return this.runMany(targets, options);
  }

  static async runMany<TAgent extends Agent>(
    this: typeof Agent,
    targets: Targets,
    options: AgentRunManyOptions = {}
  ): Promise<Array<[string, any | Error]>> {
    const { fabric, gatherExceptions = true } = options;
    const resolvedFabric = fabric ?? FameFabric.current();

    const proxies = new Map<string, Agent>();
    const tasks: Promise<any>[] = [];
    const addresses: string[] = [];

    for (const [address, payload] of targets) {
      const addressKey = String(address);
      const proxyInstance = (() => {
        const existing = proxies.get(addressKey);
        if (existing) {
          return existing;
        }
        const created = this.remoteByAddress<TAgent>(address, {
          fabric: resolvedFabric,
        });
        proxies.set(addressKey, created);
        return created;
      })();

      tasks.push(invokeProxyRunTask(proxyInstance, payload, generateId()));
      addresses.push(addressKey);
    }

    if (!gatherExceptions) {
      const results = await Promise.all(tasks);
      return results.map((value, index) => [addresses[index], value] as const);
    }

    const settled = await Promise.allSettled(tasks);
    return settled.map((result, index) => {
      const addressKey = addresses[index];
      if (result.status === 'fulfilled') {
        return [addressKey, result.value] as const;
      }
      return [addressKey, result.reason] as const;
    });
  }

  async aserve(address: FameAddress | string, options: AgentServeOptions = {}): Promise<void> {
    // Extract logLevel, pass everything else to fabric
    const { logLevel = null, ...fabricOptions } = options;

    if (logLevel !== null && logLevel !== undefined) {
      const resolvedLevel = normalizeLogLevel(logLevel);
      basicConfig({ level: resolvedLevel });
    }

    const stop = new Deferred<void>();
    const removeSignalHandlers = await setupSignalHandlers(stop);
    const { fabric, release } = await acquireFabric(fabricOptions);

    const serviceName = address instanceof FameAddress ? address.toString() : String(address);

    try {
      await fabric.serve(this, serviceName);
      logger.info('agent_live', {
        agent: this.constructor.name,
        address: serviceName,
      });

      await stop.promise;
      logger.info('agent_shutdown', {
        agent: this.constructor.name,
        address: serviceName,
      });
    } finally {
      removeSignalHandlers();
      await release();
    }
  }

  serve(address: FameAddress | string, options: AgentServeOptions = {}): Promise<void> {
    return this.aserve(address, options);
  }
}
