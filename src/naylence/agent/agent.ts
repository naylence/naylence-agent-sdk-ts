/**
 * Agent module providing the abstract {@link Agent} class.
 *
 * An Agent is a self-contained unit of work that can receive tasks, process them,
 * and return results. Agents communicate over the Fame fabric using a standard
 * task-based protocol.
 *
 * @remarks
 * For concrete implementations:
 * - Use {@link BaseAgent} when you need full control over task handling and state.
 * - Use {@link BackgroundTaskAgent} for long-running or async background work.
 *
 * @module
 */
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

/**
 * Payload type for agent task messages.
 *
 * Can be a JSON object, a string, or null.
 */
export type Payload = Record<string, unknown> | string | null;

/**
 * Collection of address-payload pairs for broadcasting tasks to multiple agents.
 */
export type Targets = Iterable<readonly [FameAddress | string, Payload]>;

/** @internal */
type AgentTaskHandler = (payload: Payload, id: string | null) => unknown | Promise<unknown>;

/**
 * Constructor signature for BaseAgent implementations.
 * @internal
 */
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

/** @internal */
const isNodeRuntime = (): boolean =>
  typeof process !== 'undefined' && process.release?.name === 'node';

/** @internal */
const LOG_LEVEL_KEYWORDS: Record<string, LogLevel> = {
  critical: LogLevel.CRITICAL,
  error: LogLevel.ERROR,
  warning: LogLevel.WARNING,
  warn: LogLevel.WARNING,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
  trace: LogLevel.TRACE,
};

/** @internal */
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

/** @internal */
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

/** @internal */
type ProcessWithSignals = {
  once: (event: string, listener: () => void) => void;
  off?: (event: string, listener: () => void) => void;
  removeListener?: (event: string, listener: () => void) => void;
};

/** @internal */
async function setupSignalHandlers(stop: Deferred<void>): Promise<() => void> {
  if (!isNodeRuntime()) {
    return () => {};
  }

  const processGlobal = globalThis as { process?: ProcessWithSignals };
  const processRef = processGlobal.process;

  if (!processRef || typeof processRef.once !== 'function') {
    return () => {};
  }

  const handler = () => stop.resolve();

  processRef.once('SIGINT', handler);
  processRef.once('SIGTERM', handler);

  return () => {
    if (typeof processRef.off === 'function') {
      processRef.off('SIGINT', handler);
      processRef.off('SIGTERM', handler);
      return;
    }

    if (typeof processRef.removeListener === 'function') {
      processRef.removeListener('SIGINT', handler);
      processRef.removeListener('SIGTERM', handler);
    }
  };
}

/** @internal */
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

/** @internal */
function toFameAddress(value: FameAddress | string): FameAddress {
  return value instanceof FameAddress ? value : new FameAddress(String(value));
}

/** @internal */
function invokeProxyRunTask(proxy: Agent, payload: Payload, taskId: string): Promise<any> {
  if (typeof proxy.runTask === 'function') {
    return proxy.runTask(payload, taskId);
  }
  throw new Error('AgentProxy must implement runTask');
}

/**
 * Options for creating a remote agent proxy.
 *
 * Provide exactly one of `address` or `capabilities` to identify the target.
 */
export interface AgentRemoteOptions {
  /** Direct address of the target agent. */
  address?: FameAddress | string;
  /** Required capabilities for capability-based discovery. */
  capabilities?: string[];
  /** Fabric instance to use. Defaults to the current fabric. */
  fabric?: FameFabric;
}

/**
 * Options for running tasks on multiple agents.
 */
export interface AgentRunManyOptions {
  /** Fabric instance to use. Defaults to the current fabric. */
  fabric?: FameFabric;
  /**
   * If true (default), errors are collected alongside results.
   * If false, the first error rejects the promise.
   */
  gatherExceptions?: boolean;
}

/**
 * Options for serving an agent at a given address.
 */
export interface AgentServeOptions {
  /**
   * Log level for the agent.
   * Accepts 'debug', 'info', 'warning', 'error', 'critical', or a LogLevel value.
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

/**
 * Abstract base class for all agents.
 *
 * Agents are addressable services that handle tasks over the Fame fabric.
 * This class defines the core protocol methods every agent must implement.
 *
 * @remarks
 * Do not extend Agent directly. Instead:
 * - Extend {@link BaseAgent} for standard request-response agents.
 * - Extend {@link BackgroundTaskAgent} for long-running background work.
 *
 * Use {@link Agent.remote} or {@link Agent.remoteByAddress} to create proxies
 * for communicating with remote agents.
 *
 * @example
 * ```typescript
 * import { BaseAgent, Payload } from '@naylence/agent-sdk';
 *
 * class EchoAgent extends BaseAgent {
 *   async runTask(payload: Payload): Promise<Payload> {
 *     return payload;
 *   }
 * }
 *
 * const agent = new EchoAgent('echo');
 * await agent.serve('fame://echo');
 * ```
 */
export abstract class Agent extends RpcMixin implements FameService {
  /**
   * Capabilities advertised by this agent for discovery.
   */
  get capabilities(): string[] | undefined {
    return undefined;
  }

  /** The agent's name, used for logging and identification. */
  abstract get name(): string | null;

  /** Returns metadata about this agent (address, capabilities, etc.). */
  abstract get spec(): Record<string, unknown>;

  /** Returns the agent's card describing its capabilities and metadata. */
  abstract getAgentCard(): Promise<AgentCard>;

  /**
   * Validates authentication credentials.
   * @param credentials - The credentials to validate.
   * @returns True if authentication succeeds.
   */
  abstract authenticate(credentials: AuthenticationInfo): boolean;

  /**
   * Initiates a new task.
   * @param params - Task parameters including message and optional metadata.
   * @returns The created task with its initial status.
   */
  abstract startTask(params: TaskSendParams): Promise<Task>;

  /**
   * Executes a task synchronously and returns the result.
   * @param payload - The task payload.
   * @param id - Optional task identifier.
   * @returns The task result.
   */
  abstract runTask(payload: Payload, id: string | null): Promise<any>;

  /**
   * Retrieves the current status of a task.
   * @param params - Query parameters including the task ID.
   */
  abstract getTaskStatus(params: TaskQueryParams): Promise<Task>;

  /**
   * Requests cancellation of a running task.
   * @param params - Parameters including the task ID.
   * @returns The task with updated status.
   */
  abstract cancelTask(params: TaskIdParams): Promise<Task>;

  /**
   * Subscribes to real-time updates for a task.
   * @param params - Task parameters.
   * @returns An async iterable of status and artifact update events.
   */
  abstract subscribeToTaskUpdates(
    params: TaskSendParams
  ): AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>;

  /**
   * Cancels a task subscription.
   * @param params - Parameters including the task ID.
   */
  abstract unsubscribeTask(params: TaskIdParams): Promise<any>;

  /**
   * Registers a push notification endpoint for task updates.
   * @param config - Push notification configuration.
   */
  abstract registerPushEndpoint(
    config: TaskPushNotificationConfig
  ): Promise<TaskPushNotificationConfig>;

  /**
   * Retrieves the push notification config for a task.
   * @param params - Parameters including the task ID.
   */
  abstract getPushNotificationConfig(params: TaskIdParams): Promise<TaskPushNotificationConfig>;

  /**
   * Creates a proxy for communicating with a remote agent.
   *
   * @remarks
   * Provide exactly one of `address` or `capabilities` in the options.
   *
   * @example
   * ```typescript
   * const proxy = Agent.remote<EchoAgent>({ address: 'fame://echo' });
   * const result = await proxy.runTask('hello');
   * ```
   *
   * @param options - Remote agent options.
   * @returns A proxy for the remote agent.
   * @throws Error if both or neither of address/capabilities are provided.
   */
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

  /**
   * Creates a proxy for a remote agent by its address.
   *
   * @param address - The target agent's address.
   * @param options - Optional fabric configuration.
   * @returns A proxy for the remote agent.
   */
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

  /**
   * Creates a proxy for a remote agent by required capabilities.
   *
   * @param capabilities - Required capabilities for discovery.
   * @param options - Optional fabric configuration.
   * @returns A proxy for a matching remote agent.
   */
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

  /**
   * Creates an agent from a simple handler function.
   *
   * @remarks
   * Useful for quick prototyping without defining a full agent class.
   *
   * @param handler - Function that processes task payloads.
   * @returns A new agent instance wrapping the handler.
   */
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

  /**
   * Sends the same payload to multiple agents.
   *
   * @param addresses - List of agent addresses.
   * @param payload - Payload to send to all agents.
   * @param options - Execution options.
   * @returns Array of [address, result|error] tuples.
   */
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

  /**
   * Runs tasks on multiple agents with individual payloads.
   *
   * @param targets - Iterable of [address, payload] pairs.
   * @param options - Execution options.
   * @returns Array of [address, result|error] tuples.
   */
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

  /**
   * Starts serving this agent at the given address.
   *
   * @remarks
   * In Node.js, the agent listens for SIGINT/SIGTERM to shut down gracefully.
   * The method returns when the agent stops serving.
   *
   * @param address - The address to serve at (e.g., 'fame://my-agent').
   * @param options - Serve options including log level and fabric config.
   */
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

  /**
   * Alias for {@link Agent.aserve}.
   *
   * @param address - The address to serve at.
   * @param options - Serve options.
   */
  serve(address: FameAddress | string, options: AgentServeOptions = {}): Promise<void> {
    return this.aserve(address, options);
  }
}
