/**
 * Agent proxy module for remote agent communication.
 *
 * An {@link AgentProxy} is a client-side handle for invoking methods on a remote
 * agent. Use it when you need to call an agent that lives in another process,
 * container, or network location.
 *
 * @remarks
 * Create proxies via {@link Agent.remote}, {@link Agent.remoteByAddress}, or
 * {@link Agent.remoteByCapabilities} rather than instantiating AgentProxy directly.
 *
 * @module
 */
import { FameAddress, generateId, createRpcProxy } from '@naylence/runtime';
import type { FameFabric } from '@naylence/runtime';
import type { FameEnvelope } from '@naylence/core';
import {
  type AgentCard,
  type AuthenticationInfo,
  type DataPart,
  type PushNotificationConfig,
  type Task,
  TaskSchema,
  type TaskArtifactUpdateEvent,
  TaskArtifactUpdateEventSchema,
  type TaskIdParams,
  TaskIdParamsSchema,
  type TaskPushNotificationConfig,
  TaskPushNotificationConfigSchema,
  type TaskQueryParams,
  TaskQueryParamsSchema,
  type TaskSendParams,
  TaskSendParamsSchema,
  TaskState,
  type TaskStatus,
  type TaskStatusUpdateEvent,
  TaskStatusUpdateEventSchema,
  type TextPart,
} from './a2a-types.js';
import { TERMINAL_TASK_STATES } from './task-states.js';
import { firstTextPart, makeTaskParams } from './util.js';
import type { MakeTaskParamsOptions } from './util.js';
import { Agent, type Payload } from './agent.js';

/** @internal */
type RunTaskPayload = Payload;

/** @internal */
type StreamParser<R> = (payload: Record<string, unknown>) => R;

/** @internal */
type AgentTaskResult<TAgent extends Agent> = Awaited<ReturnType<TAgent['runTask']>>;

/** @internal */
interface AgentProxyCtorOptions {
  address?: FameAddress | string | null;
  capabilities?: string[] | null;
  intentNl?: string | null;
  fabric: FameFabric;
}

/** @internal */
interface StreamOptions {
  timeoutMs?: number | null;
  maxItems?: number | null;
}

/** @internal */
function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as Record<string, unknown>;
}

/** @internal */
function toFameAddress(address: FameAddress | string): FameAddress {
  return address instanceof FameAddress ? address : new FameAddress(String(address));
}

/** @internal */
function wrapAgentProxy<T extends AgentProxy>(proxy: T): T {
  // Create RPC proxy options - only include address or capabilities, not both
  const proxyOptions: any = {
    fabric: proxy.proxyFabric,
  };

  if (proxy.address) {
    proxyOptions.address = proxy.address;
  } else if (proxy.capabilities) {
    proxyOptions.capabilities = proxy.capabilities;
  }

  // Create an RPC proxy with the same configuration as the AgentProxy
  const rpcProxy = createRpcProxy(proxyOptions);

  // Create a new Proxy that intercepts method calls and routes them appropriately
  return new Proxy(proxy, {
    get(target, prop, receiver) {
      // If the property exists on the original AgentProxy, use it
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      // For RPC methods (public methods not starting with _), delegate to RPC proxy
      if (typeof prop === 'string' && !prop.startsWith('_')) {
        return Reflect.get(rpcProxy, prop, rpcProxy);
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

/** @internal */
async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number | null | undefined
): Promise<IteratorResult<T> | 'timeout'> {
  if (timeoutMs == null) {
    return await iterator.next();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    return (await Promise.race([iterator.next(), timeoutPromise])) as IteratorResult<T> | 'timeout';
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Client-side proxy for communicating with remote agents.
 *
 * AgentProxy implements the {@link Agent} interface, allowing you to call
 * remote agents as if they were local objects. Method calls are serialized
 * and sent over the Fame fabric.
 *
 * @remarks
 * Do not instantiate AgentProxy directly. Use the factory methods on
 * {@link Agent} to create proxies:
 * - {@link Agent.remote} for flexible options
 * - {@link Agent.remoteByAddress} for direct addressing
 * - {@link Agent.remoteByCapabilities} for capability-based discovery
 *
 * The proxy also supports arbitrary RPC method calls. Any method not defined
 * on the proxy class is forwarded as an RPC call to the remote agent.
 *
 * @example
 * ```typescript
 * import { Agent } from '@naylence/agent-sdk';
 *
 * // Create a proxy to a remote agent
 * const proxy = Agent.remoteByAddress('fame://calculator');
 *
 * // Run a task synchronously
 * const result = await proxy.runTask({ a: 1, b: 2 });
 *
 * // Or start a task and poll for completion
 * const task = await proxy.startTask({
 *   id: 'task-1',
 *   message: { role: 'user', parts: [{ type: 'text', text: 'compute' }] },
 * });
 * ```
 *
 * @typeParam TAgent - The type of the remote agent for result typing.
 */
export class AgentProxy<TAgent extends Agent = Agent> extends Agent {
  /** @internal */
  private readonly targetAddress: FameAddress | null;
  /** @internal */
  private readonly targetCapabilities: string[] | null;
  /** @internal */
  private readonly intentNl: string | null;
  /** @internal */
  private readonly fabric: FameFabric;

  /**
   * Index signature allowing arbitrary RPC method calls.
   * Methods not defined on AgentProxy are forwarded to the remote agent.
   */
  [key: string]: any;

  /** @internal */
  constructor(options: AgentProxyCtorOptions) {
    const { address = null, capabilities = null, intentNl = null, fabric } = options;

    const provided =
      Number(address != null) + Number(capabilities != null) + Number(intentNl != null);
    if (provided !== 1) {
      throw new Error('Provide exactly one of address | capabilities | intentNl');
    }

    const normalizedAddress = address != null ? toFameAddress(address) : null;
    const normalizedCapabilities = capabilities != null ? [...capabilities] : null;

    // Call parent constructor - Agent extends RpcMixin which has no required params
    super();

    this.targetAddress = normalizedAddress;
    this.targetCapabilities = normalizedCapabilities;
    this.intentNl = intentNl;
    this.fabric = fabric;
  }

  /** Returns null as proxies do not have a local name. */
  get name(): string | null {
    return null;
  }

  /** Returns the proxy's targeting specification. */
  get spec(): Record<string, unknown> {
    const spec: Record<string, unknown> = {
      address: this.targetAddress ? this.targetAddress.toString() : null,
    };

    if (this.targetCapabilities) {
      spec.capabilities = [...this.targetCapabilities];
    }

    if (this.intentNl) {
      spec.intentNl = this.intentNl;
    }

    return spec;
  }

  /**
   * The target agent's address, if specified.
   * @deprecated Use {@link AgentProxy.address} instead.
   */
  get addressRef(): FameAddress | null {
    return this.targetAddress;
  }

  /** The target agent's address, if specified. */
  get address(): FameAddress | null {
    return this.targetAddress;
  }

  /** The required capabilities for discovery, if specified. */
  get capabilities(): string[] | undefined {
    return this.targetCapabilities ?? undefined;
  }

  /** The fabric this proxy uses for communication. */
  get proxyFabric(): FameFabric {
    return this.fabric;
  }

  async getAgentCard(): Promise<AgentCard> {
    throw new Error('Fetching remote AgentCard not yet implemented');
  }

  authenticate(_credentials: AuthenticationInfo): boolean {
    void _credentials;
    throw new Error('Proxy authentication is not supported');
  }

  /**
   * Executes a task on the remote agent and waits for completion.
   *
   * Starts the task, subscribes to updates, and returns when the task reaches
   * a terminal state (completed, failed, or canceled).
   *
   * @param payload - The task payload to send.
   * @param id - Optional task identifier. Generated if not provided.
   * @returns The task result extracted from the final status message.
   * @throws Error if the task fails.
   *
   * @example
   * ```typescript
   * const proxy = Agent.remoteByAddress('fame://echo');
   * const result = await proxy.runTask('hello');
   * console.log(result); // 'hello'
   * ```
   */
  async runTask(
    payload: RunTaskPayload = null,
    id: string | null = null
  ): Promise<AgentTaskResult<TAgent>> {
    const taskId = id ?? generateId();
    const params = makeTaskParams({ id: taskId, payload });
    const task = await this.startTask(params);

    let status: TaskStatus = task.status;

    if (!TERMINAL_TASK_STATES.has(status.state)) {
      const updates = this.subscribeToTaskUpdates(makeTaskParams({ id: taskId, payload: null }));
      const iterator = updates[Symbol.asyncIterator]();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            break;
          }

          const event = next.value;
          if (event && typeof (event as TaskStatusUpdateEvent).status === 'object') {
            const statusEvent = event as TaskStatusUpdateEvent;
            status = statusEvent.status;
            if (TERMINAL_TASK_STATES.has(status.state)) {
              break;
            }
          }
        }
      } finally {
        if (typeof iterator.return === 'function') {
          await iterator.return();
        }
      }
    }

    if (status.state === TaskState.FAILED) {
      const message = status.message ?? null;
      const error = firstTextPart(message) ?? 'Unknown error';
      throw new Error(error);
    }

    const message = status.message ?? null;
    if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
      return null as AgentTaskResult<TAgent>;
    }

    const [first] = message.parts;
    if (!first) {
      return null as AgentTaskResult<TAgent>;
    }

    if (first.type === 'text') {
      return ((first as TextPart).text ?? null) as AgentTaskResult<TAgent>;
    }

    if (first.type === 'data') {
      return (first as DataPart).data as AgentTaskResult<TAgent>;
    }

    throw new Error(`Don't know how to extract payload from part: ${first.type}`);
  }

  /**
   * Initiates a task on the remote agent.
   *
   * Returns immediately with the initial task status. Use
   * {@link AgentProxy.subscribeToTaskUpdates} or polling with
   * {@link AgentProxy.getTaskStatus} to track progress.
   *
   * @param params - Task parameters or convenience options.
   * @returns The created task with initial status.
   */
  async startTask(params: TaskSendParams): Promise<Task>;
  async startTask(options: {
    id: string;
    role?: TaskSendParams['message']['role'];
    payload: Payload;
    sessionId?: string | null;
    acceptedOutputModes?: string[] | null;
    pushNotification?: PushNotificationConfig | null;
    historyLength?: number | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<Task>;
  async startTask(
    paramsOrOptions:
      | TaskSendParams
      | {
          id: string;
          role?: TaskSendParams['message']['role'];
          payload: Payload;
          sessionId?: string | null;
          acceptedOutputModes?: string[] | null;
          pushNotification?: PushNotificationConfig | null;
          historyLength?: number | null;
          metadata?: Record<string, unknown> | null;
        }
  ): Promise<Task> {
    const params =
      'message' in paramsOrOptions
        ? TaskSendParamsSchema.parse(paramsOrOptions)
        : (() => {
            const options: MakeTaskParamsOptions = {
              id: paramsOrOptions.id,
              payload: paramsOrOptions.payload,
              sessionId: paramsOrOptions.sessionId ?? null,
              acceptedOutputModes: paramsOrOptions.acceptedOutputModes ?? null,
              pushNotification: paramsOrOptions.pushNotification ?? null,
              historyLength: paramsOrOptions.historyLength ?? null,
              metadata: paramsOrOptions.metadata ?? null,
            };

            if (paramsOrOptions.role !== undefined) {
              options.role = paramsOrOptions.role;
            }

            return makeTaskParams(options);
          })();

    const result = await this._invokeTarget('tasks/send', params);
    return TaskSchema.parse(result);
  }

  /**
   * Retrieves the current status of a task.
   *
   * @param params - Query parameters including the task ID.
   * @returns The task with current status.
   */
  async getTaskStatus(params: TaskQueryParams): Promise<Task> {
    const payload = TaskQueryParamsSchema.parse(params);
    const result = await this._invokeTarget('tasks/get', payload);
    return TaskSchema.parse(result);
  }

  /**
   * Requests cancellation of a running task.
   *
   * @param params - Parameters including the task ID.
   * @returns The task with updated status.
   */
  async cancelTask(params: TaskIdParams): Promise<Task> {
    const payload = TaskIdParamsSchema.parse(params);
    const result = await this._invokeTarget('tasks/cancel', payload);
    return TaskSchema.parse(result);
  }

  /**
   * Subscribes to real-time updates for a task.
   *
   * Returns an async iterable that yields status and artifact events
   * until the task reaches a terminal state or the stream is closed.
   *
   * @param params - Task parameters.
   * @param options - Optional timeout and item limit settings.
   * @returns Async iterable of task events.
   */
  subscribeToTaskUpdates(
    params: TaskSendParams,
    options: StreamOptions = {}
  ): AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const payload = TaskSendParamsSchema.parse(params);

    return this._streamRpc(
      'tasks/sendSubscribe',
      payload,
      (frame) => {
        if (Object.prototype.hasOwnProperty.call(frame, 'artifact')) {
          return TaskArtifactUpdateEventSchema.parse(frame);
        }
        return TaskStatusUpdateEventSchema.parse(frame);
      },
      'tasks/sendUnsubscribe',
      TaskIdParamsSchema.parse({ id: payload.id }),
      options
    );
  }

  /**
   * Cancels a task subscription.
   *
   * @param params - Parameters including the task ID.
   */
  async unsubscribeTask(params: TaskIdParams): Promise<unknown> {
    const payload = TaskIdParamsSchema.parse(params);
    return await this._invokeTarget('tasks/sendUnsubscribe', payload);
  }

  /**
   * Registers a push notification endpoint for task updates.
   *
   * @param config - Push notification configuration.
   * @returns The registered configuration.
   */
  async registerPushEndpoint(
    config: TaskPushNotificationConfig
  ): Promise<TaskPushNotificationConfig> {
    const payload = TaskPushNotificationConfigSchema.parse(config);
    const result = await this._invokeTarget('tasks/pushNotification/set', payload);
    return TaskPushNotificationConfigSchema.parse(result ?? payload);
  }

  /**
   * Retrieves the push notification config for a task.
   *
   * @param params - Parameters including the task ID.
   * @returns The push notification configuration.
   */
  async getPushNotificationConfig(params: TaskIdParams): Promise<TaskPushNotificationConfig> {
    const payload = TaskIdParamsSchema.parse(params);
    const result = await this._invokeTarget('tasks/pushNotification/get', payload);
    return TaskPushNotificationConfigSchema.parse(result ?? payload);
  }

  /** @internal */
  private _streamRpc<R>(
    method: string,
    params: TaskSendParams,
    parseFrame: StreamParser<R>,
    unsubscribeMethod: string,
    unsubscribeParams: TaskIdParams,
    options: StreamOptions
  ): AsyncIterable<R> {
    const self = this;

    return {
      [Symbol.asyncIterator](): AsyncIterator<R> {
        let iterator: AsyncIterator<unknown> | null = null;
        let completed = false;
        let count = 0;

        const setup = async () => {
          if (iterator) {
            return iterator;
          }
          const result = await self._invokeTarget(method, params, {
            streaming: true,
          });
          if (
            !result ||
            typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function'
          ) {
            throw new Error('Expected streaming RPC to return an AsyncIterable');
          }
          iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          return iterator;
        };

        const cleanup = async () => {
          if (completed) {
            return;
          }
          completed = true;
          try {
            if (iterator && typeof iterator.return === 'function') {
              await iterator.return();
            }
          } catch (error) {
            void error;
          }
          await self._invokeTarget(unsubscribeMethod, unsubscribeParams);
        };

        return {
          async next(): Promise<IteratorResult<R>> {
            const source = await setup();
            const result = await nextWithTimeout(source, options.timeoutMs ?? null);
            if (result === 'timeout') {
              await cleanup();
              return { done: true, value: undefined };
            }

            const { value, done } = result;
            if (done || value === undefined || value === null) {
              await cleanup();
              return { done: true, value: undefined };
            }

            if (options.maxItems != null && count >= options.maxItems) {
              await cleanup();
              return { done: true, value: undefined };
            }

            count += 1;
            const parsed = parseFrame(toRecord(value));
            return { done: false, value: parsed };
          },
          async return(value?: R): Promise<IteratorResult<R>> {
            await cleanup();
            return { done: true, value: value as R | undefined };
          },
          async throw(err?: unknown): Promise<IteratorResult<R>> {
            await cleanup();
            throw err;
          },
        };
      },
    };
  }

  /** @internal */
  private async _invokeTarget(
    method: string,
    params: Record<string, unknown> | TaskSendParams,
    options: { streaming?: boolean } = {}
  ): Promise<any> {
    if (this.intentNl) {
      throw new Error('Intent-based routing not yet supported');
    }

    const payload = toRecord(params);

    if (this.targetAddress) {
      if (options.streaming) {
        return await this.fabric.invokeStream(this.targetAddress, method, payload);
      }
      return await this.fabric.invoke(this.targetAddress, method, payload);
    }

    if (this.targetCapabilities) {
      if (options.streaming) {
        return await this.fabric.invokeByCapabilityStream(this.targetCapabilities, method, payload);
      }
      return await this.fabric.invokeByCapability(this.targetCapabilities, method, payload);
    }

    throw new Error('Proxy has no routing target');
  }

  /**
   * Creates a proxy for a remote agent by address.
   * @internal Use {@link Agent.remoteByAddress} instead.
   */
  static remoteByAddress<TAgent extends Agent>(
    address: FameAddress,
    options: { fabric: FameFabric }
  ): AgentProxy<TAgent> {
    const proxy = new AgentProxy<TAgent>({ address, fabric: options.fabric });
    return wrapAgentProxy(proxy);
  }

  /**
   * Creates a proxy for a remote agent by capabilities.
   * @internal Use {@link Agent.remoteByCapabilities} instead.
   */
  static remoteByCapabilities<TAgent extends Agent>(
    capabilities: string[],
    options: { fabric: FameFabric }
  ): AgentProxy<TAgent> {
    const proxy = new AgentProxy<TAgent>({ capabilities, fabric: options.fabric });
    return wrapAgentProxy(proxy);
  }
}
export type { FameEnvelope };
