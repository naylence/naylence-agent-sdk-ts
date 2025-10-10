import {
  AGENT_CAPABILITY,
  createFameEnvelope,
  createMessageResponse,
  type DataFrame,
  type DeliveryAckFrame,
  type FameDeliveryContext,
  type FameEnvelope,
  type FameMessageResponse,
} from 'naylence-core';
import {
  AsyncLock,
  FameAddress,
  FameFabric,
  generateId,
  getLogger,
  getCurrentNode,
  type KeyValueStore,
  type StorageProvider,
} from 'naylence-runtime';
import { z } from 'zod';

import {
  Agent,
  type BaseAgentConstructor,
  type Payload,
  registerBaseAgentConstructor,
} from './agent.js';
import {
  type AgentCard,
  Task,
  type TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskSendParams,
  TaskState,
  TaskStatusUpdateEvent,
  TaskStatusUpdateEventSchema,
} from './a2a-types.js';
import { TERMINAL_TASK_STATES } from './task-states.js';
import {
  PushNotificationNotSupportedException,
  TaskNotCancelableException,
  UnsupportedOperationException,
} from './errors.js';
import { decodeFameDataPayload, makeTask } from './util.js';
import { handleAgentRpcRequest } from './rpc-adapter.js';

const logger = getLogger('naylence.agent.base-agent');

export { TERMINAL_TASK_STATES };

type JsonRpcParams = Record<string, unknown>;

interface JsonRpcRequest extends Record<string, unknown> {
  jsonrpc: string;
  method: string;
  params?: JsonRpcParams;
  id?: string | number | null;
}

class StateContext<StateT extends BaseAgentState> {
  private releaseLock: (() => void) | null = null;
  private loadedState: StateT | null = null;

  constructor(
    private readonly acquireLock: () => Promise<() => void>,
    private readonly loadState: () => Promise<StateT>,
    private readonly saveState: (state: StateT) => Promise<void>
  ) {}

  async enter(): Promise<StateT> {
    const release = await this.acquireLock();
    this.releaseLock = release;
    try {
      const state = await this.loadState();
      this.loadedState = state;
      return state;
    } catch (error) {
      release();
      this.releaseLock = null;
      throw error;
    }
  }

  async exit(error?: unknown): Promise<void> {
    try {
      if (!error && this.loadedState) {
        await this.saveState(this.loadedState);
      }
    } finally {
      this.loadedState = null;
      if (this.releaseLock) {
        this.releaseLock();
        this.releaseLock = null;
      }
    }
  }

  async use<T>(callback: (state: StateT) => Promise<T>): Promise<T> {
    const state = await this.enter();
    try {
      return await callback(state);
    } finally {
      await this.exit();
    }
  }
}

/**
 * Base class for agent state with Pydantic-like serialization and validation.
 * 
 * Provides feature parity with Python's BaseAgentState:
 * - Schema-based validation using Zod (equivalent to Pydantic validators)
 * - Type-safe serialization and deserialization
 * - Custom toJSON/fromJSON methods for proper persistence
 * 
 * @example Basic usage
 * ```typescript
 * import { z } from 'zod';
 * 
 * const CounterStateSchema = z.object({
 *   count: z.number().int().nonnegative(),
 * });
 * 
 * class CounterState extends BaseAgentState {
 *   static readonly schema = CounterStateSchema;
 *   count: number = 0;
 * }
 * ```
 * 
 * @example With nested objects
 * ```typescript
 * const ItemSchema = z.object({
 *   id: z.string().uuid(),
 *   name: z.string(),
 * });
 * 
 * const InventoryStateSchema = z.object({
 *   items: z.array(ItemSchema),
 * });
 * 
 * class InventoryState extends BaseAgentState {
 *   static readonly schema = InventoryStateSchema;
 *   items: Array<{ id: string; name: string }> = [];
 * }
 * ```
 */
export class BaseAgentState {
  /**
   * Zod schema for state validation.
   * 
   * Subclasses should override this to define their validation schema.
   * This provides runtime type safety equivalent to Pydantic's field validators.
   * 
   * @example
   * ```typescript
 *   static readonly schema = z.object({
   *   count: z.number().int(),
   *   items: z.array(z.string()),
   * });
   * ```
   */
  static readonly schema: z.ZodType<any> = z.object({});

  /**
   * Serialize state to JSON using schema validation.
   * 
   * Override in subclasses to customize serialization behavior.
   * The default implementation:
   * 1. Extracts all enumerable own properties
   * 2. Validates against schema if defined
   * 3. Returns validated data
   * 
   * This is automatically called by JSON.stringify() and storage providers.
   * 
   * @returns Plain object representation of the state
   * @throws {Error} If state doesn't match schema (wraps z.ZodError)
   * 
   * @example
   * ```typescript
   * toJSON() {
   *   // Custom serialization with specific fields
   *   return {
   *     count: this.count,
   *     lastUpdated: this.lastUpdated.toISOString(),
   *   };
   * }
   * ```
   */
  toJSON(): unknown {
    const ctor = this.constructor as typeof BaseAgentState;
    
    // Extract all enumerable own properties (exclude methods and agent reference)
    const data: Record<string, unknown> = {};
    for (const key in this) {
      if (Object.prototype.hasOwnProperty.call(this, key)) {
        const value = this[key];
        
        // Handle nested BaseAgentState instances
        if (value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') {
          data[key] = value.toJSON();
        } else {
          data[key] = value;
        }
      }
    }
    
    // If schema is defined, validate the extracted data
    if (ctor.schema && ctor.schema !== BaseAgentState.schema) {
      try {
        // Validate and potentially transform the data
        return ctor.schema.parse(data);
      } catch (error) {
        // Re-throw with context
        if (error instanceof z.ZodError) {
          const className = ctor.name;
          const errorMessages = error.issues.map((e: z.ZodIssue) => 
            `${e.path.join('.')}: ${e.message}`
          ).join(', ');
          throw new Error(`Failed to serialize ${className}: ${errorMessages}`);
        }
        throw error;
      }
    }
    
    return data;
  }

  /**
   * Deserialize and validate data using the schema.
   * 
   * This provides runtime type safety equivalent to Pydantic's model_validate_json.
   * 
   * @param data - Plain object data to deserialize
   * @returns Validated instance of the state class
   * @throws {z.ZodError} If data doesn't match schema
   * 
   * @example
   * ```typescript
   * const state = CounterState.fromJSON({ count: 42 });
   * ```
   * 
   * @example Error handling
   * ```typescript
   * try {
   *   const state = CounterState.fromJSON(untrustedData);
   * } catch (error) {
   *   if (error instanceof z.ZodError) {
   *     console.error('Validation failed:', error.errors);
   *   }
   * }
   * ```
   */
  static fromJSON<T extends BaseAgentState>(
    this: new () => T,
    data: unknown
  ): T {
    const ctor = this as unknown as typeof BaseAgentState;
    
    // Validate against schema if defined
    let validated: any;
    if (ctor.schema && ctor.schema !== BaseAgentState.schema) {
      try {
        validated = ctor.schema.parse(data);
      } catch (error) {
        if (error instanceof z.ZodError) {
          const className = ctor.name;
          const errorMessages = error.issues.map((e: z.ZodIssue) => 
            `${e.path.join('.')}: ${e.message}`
          ).join(', ');
          throw new Error(`Failed to deserialize ${className}: ${errorMessages}`);
        }
        throw error;
      }
    } else {
      validated = data;
    }
    
    // Create instance and assign validated data
    const instance = new this();
    Object.assign(instance, validated);
    return instance;
  }

  /**
   * Create a validated copy of this state instance.
   * 
   * Useful for creating snapshots or clones with validation.
   * 
   * @returns A new instance with the same data
   * @throws {z.ZodError} If current state doesn't match schema
   */
  clone(): this {
    const ctor = this.constructor as new () => this;
    const json = this.toJSON();
    return (ctor as any).fromJSON(json);
  }
}

type StateModelCtor<T extends BaseAgentState> = new () => T;

interface SubscriptionTask {
  cancel(): void;
  promise: Promise<void>;
}

export interface BaseAgentOptions<StateT extends BaseAgentState> {
  stateModel?: StateModelCtor<StateT> | null;
  stateNamespace?: string | null;
  stateKey?: string;
  stateFactory?: (() => StateT) | null;
  storageProvider?: StorageProvider | null;
}

function camelToSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function sanitizeNamespace(ns: string): string {
  const replaced = ns.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  const safe = replaced.length > 0 ? replaced : 'ns';
  return safe.slice(0, 120);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    const timeout = globalThis.setTimeout;
    if (typeof timeout !== 'function') {
      throw new Error('setTimeout is not available in the current environment');
    }
    timeout(resolve, ms);
  });
}

function resolveRpcParams(params: JsonRpcRequest['params']): JsonRpcParams {
  if (params && typeof params === 'object') {
    return params as JsonRpcParams;
  }
  return {};
}

function resolveReplyTarget(
  explicit: string | FameAddress | null | undefined,
  params: JsonRpcParams
): string | FameAddress | null {
  const fromParams =
    (params['reply_to'] as string | FameAddress | null | undefined) ??
    (params['replyTo'] as string | FameAddress | null | undefined);
  const resolved = explicit ?? fromParams ?? null;
  return resolved === undefined ? null : resolved;
}

export class BaseAgent<StateT extends BaseAgentState = BaseAgentState> extends Agent {
  static STATE_MODEL: StateModelCtor<BaseAgentState> | null = null;

  private _name: string | null;
  private _address: FameAddress | null = null;
  private readonly _capabilities: string[] = [AGENT_CAPABILITY];
  private readonly _subscriptions = new Map<string, SubscriptionTask>();
  protected _storageProvider: StorageProvider | null;
  private readonly _stateLock = new AsyncLock();
  private _stateModel: StateModelCtor<StateT> | null;
  private readonly _stateNamespaceRaw: string | null;
  private readonly _stateKey: string;
  private readonly _stateFactory: (() => StateT) | null;
  private _stateStore: KeyValueStore<StateT> | null = null;
  private _stateCache: StateT | null = null;

  constructor(name: string | null = null, options: BaseAgentOptions<StateT> = {}) {
    super();
    this._name = name ?? camelToSnakeCase(this.constructor.name);
    this._storageProvider = options.storageProvider ?? null;
    this._stateModel =
      options.stateModel ??
      ((this.constructor as typeof BaseAgent).STATE_MODEL as StateModelCtor<StateT> | null);
    this._stateNamespaceRaw = options.stateNamespace ?? null;
    this._stateKey = options.stateKey ?? 'state';
    this._stateFactory = options.stateFactory ?? null;
  }

  get capabilities(): string[] {
    return [...this._capabilities];
  }

  get name(): string | null {
    return this._name;
  }

  get spec(): Record<string, unknown> {
    return {
      address: this._address?.toString() ?? null,
    };
  }

  get address(): FameAddress | null {
    return this._address;
  }

  set address(value: FameAddress | null) {
    this._address = value;
  }

  get storageProvider(): StorageProvider {
    if (!this._storageProvider) {
      // Try to get storage provider from current node context (matches Python behavior)
      const node = getCurrentNode();
      if (node) {
        this._storageProvider = node.storageProvider;
      }
    }

    if (!this._storageProvider) {
      throw new Error(
        'Storage provider is not available. Supply one via BaseAgent options or override BaseAgent.storageProvider.'
      );
    }

    return this._storageProvider;
  }

  protected async acquireStateLock(): Promise<() => void> {
    let acquiredResolve!: () => void;
    const acquired = new Promise<void>((resolve) => {
      acquiredResolve = resolve;
    });

    let releaseResolve!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });

    const guard = this._stateLock.runExclusive(async () => {
      acquiredResolve();
      await releaseSignal;
    });

    await acquired;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      releaseResolve();
      void guard.catch((error) => {
        logger.error('state_lock_release_failed', { error });
      });
    };
  }

  private ensureStateModel(): StateModelCtor<StateT> {
    if (this._stateModel) {
      return this._stateModel;
    }
    throw new Error(
      "No state model configured. Provide via Generic, STATE_MODEL, constructor 'stateModel', or 'stateFactory'."
    );
  }

  private async ensureStateStore(modelType: StateModelCtor<StateT>): Promise<void> {
    if (this._stateStore) {
      return;
    }

    const provider = this.storageProvider;
    if (!provider) {
      throw new Error('Storage provider is not available');
    }

    const namespaceRaw = this._stateNamespaceRaw ?? this.defaultStateNamespace();
    const namespace = sanitizeNamespace(namespaceRaw);
    this._stateStore = await provider.getKeyValueStore(modelType, namespace);
  }

  private defaultStateNamespace(): string {
    if (!this._name) {
      throw new Error(
        "Cannot derive default state namespace without agent name. Set 'name' or provide 'stateNamespace'."
      );
    }
    return `__agent_${this._name}`;
  }

  protected async loadStateInternal(): Promise<StateT> {
    if (this._stateCache) {
      return this._stateCache;
    }

    const modelType = this.ensureStateModel();
    await this.ensureStateStore(modelType);

    const existing = await this._stateStore!.get(this._stateKey);
    let state: StateT;
    
    if (existing !== undefined && existing !== null) {
      // Use fromJSON if available for validation
      const ctor = modelType as any;
      if (typeof ctor.fromJSON === 'function') {
        // Serialize and deserialize to apply validation
        // This ensures data from storage passes through validation
        const json = JSON.stringify(existing);
        const data = JSON.parse(json);
        state = ctor.fromJSON(data);
      } else {
        state = existing;
      }
    } else {
      state = this._stateFactory ? this._stateFactory() : new modelType();
      await this._stateStore!.set(this._stateKey, state);
    }

    this._stateCache = state;

    return state;
  }

  protected async saveStateInternal(state: StateT): Promise<void> {
    const modelType = this.ensureStateModel();
    await this.ensureStateStore(modelType);
    
    // Validate state before saving if toJSON is available
    // This triggers Zod schema validation
    if (typeof state.toJSON === 'function') {
      state.toJSON(); // Will throw if validation fails
    }
    
    await this._stateStore!.set(this._stateKey, state);
    this._stateCache = state;
  }

  get state(): StateContext<StateT> {
    if (!this._stateModel && !this._stateFactory) {
      throw new Error('No state model configured');
    }
    return new StateContext<StateT>(
      () => this.acquireStateLock(),
      () => this.loadStateInternal(),
      (state) => this.saveStateInternal(state)
    );
  }

  async withState<T>(callback: (state: StateT) => Promise<T>): Promise<T> {
    return await this.state.use(callback);
  }

  async getState(): Promise<StateT> {
    const release = await this.acquireStateLock();
    try {
      return await this.loadStateInternal();
    } finally {
      release();
    }
  }

  async clearState(): Promise<void> {
    const release = await this.acquireStateLock();
    try {
      if (this._stateStore) {
        await this._stateStore.delete(this._stateKey);
      }
      this._stateCache = null;
    } finally {
      release();
    }
  }

  private static isRpcRequest(payload: unknown): payload is JsonRpcRequest {
    if (!payload || typeof payload !== 'object') {
      return false;
    }

    const candidate = payload as Record<string, unknown>;
    if (typeof candidate.jsonrpc !== 'string' || typeof candidate.method !== 'string') {
      return false;
    }

    const { params } = candidate;
    if (params !== undefined && (typeof params !== 'object' || params === null)) {
      return false;
    }

    return true;
  }

  async handleMessage(
    envelope: FameEnvelope,
    _context?: FameDeliveryContext
  ): Promise<FameMessageResponse | AsyncIterable<FameMessageResponse> | null> {
    void _context;
    const frame = envelope.frame;

    if ((frame as DeliveryAckFrame).type === 'DeliveryAck') {
      const ack = frame as DeliveryAckFrame;
      if (!ack.ok && envelope.corrId) {
        const subscription = this._subscriptions.get(envelope.corrId);
        if (subscription) {
          subscription.cancel();
        }
      }
      return null;
    }

    if ((frame as DataFrame).type !== 'Data') {
      const frameType = (frame as { type?: unknown }).type ?? typeof frame;
      throw new Error(`Invalid envelope frame. Expected DataFrame, actual: ${String(frameType)}`);
    }

    const decoded = decodeFameDataPayload(frame as DataFrame);

    if (!BaseAgent.isRpcRequest(decoded)) {
      return await this.onMessage(decoded);
    }

    return await this.handleRpcMessage(decoded, envelope);
  }

  async onMessage(message: unknown): Promise<FameMessageResponse | null> {
    logger.warning('unhandled_inbound_message', { message });
    return null;
  }

  private async handleRpcMessage(
    rpcRequest: JsonRpcRequest,
    envelope: FameEnvelope
  ): Promise<FameMessageResponse | AsyncIterable<FameMessageResponse> | null> {
    if (rpcRequest.method === 'tasks/sendSubscribe') {
      this.startSubscriptionTask(rpcRequest, envelope.replyTo ?? null);
      return null;
    }

    const params = resolveRpcParams(rpcRequest.params);
    const replyTo = resolveReplyTarget(envelope.replyTo, params);
    if (!replyTo) {
      logger.warning('missing_reply_to', { rpcMethod: rpcRequest.method });
      return null;
    }

    const traceId = envelope.traceId ?? null;

    const generator = async function* (
      this: BaseAgent<StateT>
    ): AsyncGenerator<FameMessageResponse> {
      for await (const rpcResponse of handleAgentRpcRequest(this as Agent, rpcRequest)) {
        const frame: DataFrame = {
          type: 'Data',
          payload: rpcResponse,
        };
        const envelopeOptions: Parameters<typeof createFameEnvelope>[0] = {
          frame,
          to: replyTo,
        };
        if (traceId !== null) {
          envelopeOptions.traceId = traceId;
        }
        if (rpcRequest.id != null) {
          envelopeOptions.corrId = String(rpcRequest.id);
        }
        const envelopeResponse = createFameEnvelope(envelopeOptions);
        yield createMessageResponse(envelopeResponse);
      }
    }.bind(this);

    return generator();
  }

  private startSubscriptionTask(
    rpcRequest: JsonRpcRequest,
    replyTo: string | FameAddress | null
  ): void {
    const id = rpcRequest.id != null ? String(rpcRequest.id) : null;
    if (!id) {
      logger.warning('subscribe_missing_id', {});
    }

    const abortController = new AbortController();
    const taskPromise = this.streamSendSubscribe(rpcRequest, replyTo, abortController.signal)
      .catch((error) => {
        if (!abortController.signal.aborted) {
          logger.error('send_subscribe_stream_failed', { error });
        }
      })
      .finally(() => {
        if (id) {
          this._subscriptions.delete(id);
        }
      });

    if (id) {
      this._subscriptions.set(id, {
        cancel: () => abortController.abort(),
        promise: taskPromise,
      });
    }
  }

  private async streamSendSubscribe(
    rpcRequest: JsonRpcRequest,
    replyTo: string | FameAddress | null,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const params = resolveRpcParams(rpcRequest.params);
      for await (const rpcResponse of handleAgentRpcRequest(this as Agent, rpcRequest)) {
        if (signal.aborted) {
          break;
        }

        const target = resolveReplyTarget(replyTo, params);
        if (!target) {
          logger.warning('missing_reply_to_in_stream', {
            rpcId: rpcRequest.id,
          });
          return;
        }

        const fameTarget = typeof target === 'string' ? new FameAddress(target) : target;
        const frame: DataFrame = {
          type: 'Data',
          payload: rpcResponse,
        };
        const envelopeOptions: Parameters<typeof createFameEnvelope>[0] = {
          frame,
          to: fameTarget,
        };
        if (rpcRequest.id != null) {
          envelopeOptions.corrId = String(rpcRequest.id);
        }
        const envelope = createFameEnvelope(envelopeOptions);
        await FameFabric.current().send(envelope);
      }
    } catch (error) {
      if (!signal.aborted) {
        logger.error('send_subscribe_stream_error', { error });
        throw error;
      }
    }
  }

  authenticate(_credentials: unknown): boolean {
    void _credentials;
    return true;
  }

  async registerPushEndpoint(
    _config: TaskPushNotificationConfig
  ): Promise<TaskPushNotificationConfig> {
    void _config;
    throw new PushNotificationNotSupportedException();
  }

  async getPushNotificationConfig(_params: TaskIdParams): Promise<TaskPushNotificationConfig> {
    void _params;
    throw new PushNotificationNotSupportedException();
  }

  async *subscribeToTaskUpdates(
    params: TaskSendParams
  ): AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    let lastState: TaskState | null = null;
    while (true) {
      const query: TaskQueryParams = { id: params.id };
      const task = await this.getTaskStatus(query);
      if (!task) {
        break;
      }

      if (task.status.state !== lastState) {
        const event = TaskStatusUpdateEventSchema.parse({
          id: task.id,
          status: task.status,
          final: TERMINAL_TASK_STATES.has(task.status.state),
          metadata: task.metadata ?? null,
        });
        yield event;
        lastState = task.status.state;
      }

      if (TERMINAL_TASK_STATES.has(task.status.state)) {
        break;
      }

      await delay(500);
    }
  }

  async unsubscribeTask(_params: TaskIdParams): Promise<unknown> {
    void _params;
    throw new UnsupportedOperationException(
      `Agent ${this.constructor.name} does not support operation 'unsubscribeTask'`
    );
  }

  async cancelTask(_params: TaskIdParams): Promise<Task> {
    void _params;
    throw new TaskNotCancelableException();
  }

  async getAgentCard(): Promise<AgentCard> {
    throw new UnsupportedOperationException(
      `Agent ${this.constructor.name} does not support operation 'getAgentCard'`
    );
  }

  async getTaskStatus(_params: TaskQueryParams): Promise<Task> {
    void _params;
    throw new UnsupportedOperationException(
      `Agent ${this.constructor.name} does not support operation 'getTaskStatus'`
    );
  }

  async runTask(_payload: Payload, _id: string | null): Promise<unknown> {
    void _payload;
    void _id;
    throw new UnsupportedOperationException(
      `Agent ${this.constructor.name} does not support operation 'runTask'`
    );
  }

  async startTask(params: TaskSendParams): Promise<Task> {
    const ctor = this.constructor as typeof BaseAgent;

    const parts = params.message?.parts ?? [];
    let payload: Payload = null;
    if (parts.length > 0) {
      const first = parts[0];
      if (first.type === 'text') {
        payload = first.text ?? null;
      } else if (first.type === 'data') {
        payload = first.data ?? null;
      }
    }

    const hasCustomRun =
      Object.prototype.hasOwnProperty.call(ctor.prototype, 'runTask') &&
      ctor.prototype.runTask !== BaseAgent.prototype.runTask;

    if (hasCustomRun) {
      return await this.#createTaskFromPayloadResponse(params, payload, (p, id) =>
        this.runTask(p, id)
      );
    }

    throw new Error(`${ctor.name} must implement at least one of: startTask() or runTask()`);
  }

  async #createTaskFromPayloadResponse(
    params: TaskSendParams,
    payload: Payload,
    runner: (payload: Payload, id: string | null) => Promise<unknown>
  ): Promise<Task> {
    const responsePayload = await runner(payload, params.id ?? null);
    let sanitizedPayload: Payload = null;

    if (typeof responsePayload === 'string') {
      sanitizedPayload = responsePayload;
    } else if (responsePayload && typeof responsePayload === 'object') {
      sanitizedPayload = responsePayload as Record<string, unknown>;
    }

    return makeTask({
      id: params.id,
      state: TaskState.COMPLETED,
      payload: sanitizedPayload,
      sessionId: params.sessionId ?? null,
    });
  }

  async aserve(
    address: FameAddress | string,
    options: Parameters<Agent['aserve']>[1] = {}
  ): Promise<void> {
    if (!this._name) {
      this._name = generateId();
    }
    await super.aserve(address, options);
  }
}

registerBaseAgentConstructor(BaseAgent as BaseAgentConstructor);
