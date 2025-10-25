import { jest } from '@jest/globals';
import {
  createFameEnvelope,
  type DataFrame,
  type FameEnvelope,
  type FameMessageResponse,
  type DeliveryAckFrame,
  type JSONRPCResponse,
} from '@naylence/core';
import {
  FameAddress,
  FameFabric,
  InMemoryStorageProvider,
  type KeyValueStore,
  type StorageProvider,
} from '@naylence/runtime';
import type { AgentCard, Task, TaskSendParams, TaskQueryParams } from '../a2a-types.js';
import {
  TaskState,
  TaskStatusUpdateEventSchema,
  TaskPushNotificationConfig,
  TaskIdParams,
} from '../a2a-types.js';
import {
  PushNotificationNotSupportedException,
  TaskNotCancelableException,
  UnsupportedOperationException,
} from '../errors.js';
import { makeTask, makeTaskParams } from '../util.js';
import { BaseAgent, BaseAgentState, type BaseAgentOptions } from '../base-agent.js';
import { Agent, type Payload } from '../agent.js';
import * as RpcAdapter from '../rpc-adapter.js';

class FakeKeyValueStore<V> implements KeyValueStore<V> {
  private readonly store = new Map<string, V>();
  getCalls = 0;
  setCalls = 0;
  deleteCalls = 0;

  async set(key: string, value: V): Promise<void> {
    this.setCalls += 1;
    this.store.set(key, value);
  }

  async update(key: string, value: V): Promise<void> {
    this.setCalls += 1;
    this.store.set(key, value);
  }

  async get(key: string): Promise<V | undefined> {
    this.getCalls += 1;
    return this.store.get(key);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    this.store.delete(key);
  }

  async list(): Promise<Record<string, V>> {
    const entries: Record<string, V> = {};
    for (const [key, value] of this.store.entries()) {
      entries[key] = value;
    }
    return entries;
  }
}

class CapturingStorageProvider implements StorageProvider {
  readonly store: FakeKeyValueStore<any>;
  lastNamespace: string | null = null;

  constructor(store?: FakeKeyValueStore<any>) {
    this.store = store ?? new FakeKeyValueStore<any>();
  }

  async getKeyValueStore<V>(_model: new () => V, namespace: string): Promise<KeyValueStore<V>> {
    this.lastNamespace = namespace;
    return this.store as KeyValueStore<V>;
  }
}

class ExampleState extends BaseAgentState {
  counter = 0;
}

class ExampleAgent extends BaseAgent<ExampleState> {
  lastRun: { payload: Payload; id: string | null } | null = null;
  private responseOverride: unknown = undefined;
  private readonly tasks = new Map<string, Task>();
  private taskSequence: Array<Task | null> = [];
  readonly onMessagePayloads: unknown[] = [];

  constructor(name: string | null = null, options: BaseAgentOptions<ExampleState> = {}) {
    super(name, { stateModel: ExampleState, ...options });
  }

  setRunTaskResponse(value: unknown): void {
    this.responseOverride = value;
  }

  queueTaskStates(states: Array<Task | null>): void {
    this.taskSequence = [...states];
  }

  setTask(task: Task | null): void {
    if (!task) {
      this.tasks.clear();
      return;
    }
    this.tasks.set(task.id, task);
  }

  override async runTask(payload: Payload, id: string | null): Promise<unknown> {
    this.lastRun = { payload, id };
    if (this.responseOverride !== undefined) {
      return this.responseOverride;
    }
    return payload;
  }

  override async getTaskStatus(params: TaskQueryParams): Promise<Task> {
    if (this.taskSequence.length > 0) {
      const next = this.taskSequence.shift() ?? null;
      if (next) {
        this.tasks.set(next.id, next);
        return next;
      }
      return null as unknown as Task;
    }
    return (this.tasks.get(params.id) ?? null) as unknown as Task;
  }

  override async getAgentCard(): Promise<AgentCard> {
    return {
      name: 'Example Agent',
      url: 'https://example.invalid',
      version: '1.0.0',
      description: null,
      provider: null,
      documentationUrl: null,
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      authentication: null,
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    } satisfies AgentCard;
  }

  override async onMessage(message: unknown): Promise<FameMessageResponse | null> {
    this.onMessagePayloads.push(message);
    return null;
  }
}

const createDataEnvelope = (
  payload: unknown,
  overrides: Partial<FameEnvelope> = {}
): FameEnvelope => {
  const frame: DataFrame = {
    type: 'Data',
    payload,
  };
  const base = createFameEnvelope({ frame });
  const sanitizedOverrides: Partial<FameEnvelope> = { ...overrides };
  if ('replyTo' in sanitizedOverrides && sanitizedOverrides.replyTo == null) {
    delete sanitizedOverrides.replyTo;
  }
  if ('to' in sanitizedOverrides && sanitizedOverrides.to == null) {
    delete sanitizedOverrides.to;
  }
  return {
    ...base,
    ...sanitizedOverrides,
    frame,
  };
};

describe('BaseAgent state management', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('derives snake_case name when not provided', () => {
    const agent = new ExampleAgent(null);
    expect(agent.name).toBe('example_agent');
  });

  test('throws when storage provider is missing', () => {
    const agent = new ExampleAgent('test-agent');
    expect(() => agent.storageProvider).toThrow('Storage provider is not available');
  });

  test('returns configured storage provider', () => {
    const provider = new InMemoryStorageProvider();
    const agent = new ExampleAgent('test', { storageProvider: provider });
    expect(agent.storageProvider).toBe(provider);
  });

  test('state getter rejects when no model configured', () => {
    const agent = new BaseAgent<BaseAgentState>('raw-agent');
    expect(() => agent.state).toThrow('No state model configured');
  });

  test('uses sanitized namespace when creating state store', async () => {
    const provider = new CapturingStorageProvider();
    const agent = new ExampleAgent('AgentName', {
      storageProvider: provider,
      stateNamespace: ' .!invalid namespace!! ',
    });

    await agent.getState();
    expect(provider.lastNamespace).toBe('invalid_namespace');
  });

  test('caches loaded state across calls', async () => {
    const store = new FakeKeyValueStore<ExampleState>();
    const provider = new CapturingStorageProvider(store);
    const agent = new ExampleAgent('cache-agent', { storageProvider: provider });

    const first = await agent.getState();
    first.counter = 5;
    const second = await agent.getState();

    expect(second).toBe(first);
    expect(store.getCalls).toBe(1);
  });

  test('withState saves mutations back to store', async () => {
    const store = new FakeKeyValueStore<ExampleState>();
    const provider = new CapturingStorageProvider(store);
    const agent = new ExampleAgent('mutating', { storageProvider: provider });

    await agent.withState(async (state) => {
      state.counter += 1;
    });

    expect(store.setCalls).toBeGreaterThanOrEqual(2);
  });

  test('clearState deletes persisted value and cache', async () => {
    const store = new FakeKeyValueStore<ExampleState>();
    const provider = new CapturingStorageProvider(store);
    const agent = new ExampleAgent('clear', { storageProvider: provider });

    await agent.getState();
    await agent.clearState();

    expect(store.deleteCalls).toBe(1);
    const fresh = await agent.getState();
    expect(fresh.counter).toBe(0);
  });

  test('acquireStateLock release is idempotent', async () => {
    const agent = new ExampleAgent('lock-agent');
    const acquireStateLock = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'acquireStateLock'
    ) as () => Promise<() => void>;
    const release = await acquireStateLock.call(agent);
    release();
    release();
  });
});

describe('BaseAgent message handling', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('cancels subscription when NACK received', async () => {
    const agent = new ExampleAgent('ack-agent');
    const cancel = jest.fn();
    const subscriptions = Reflect.get(
      agent as unknown as Record<string, unknown>,
      '_subscriptions'
    ) as Map<string, { cancel: () => void; promise: Promise<void> }>;
    subscriptions.set('corr-1', { cancel, promise: Promise.resolve() });

    const envelope = {
      frame: { type: 'DeliveryAck', ok: false } satisfies DeliveryAckFrame,
      corrId: 'corr-1',
    } as unknown as FameEnvelope;

    const result = await agent.handleMessage(envelope);
    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('ignores ACK without canceling subscription', async () => {
    const agent = new ExampleAgent('ack-ok');
    const cancel = jest.fn();
    const subscriptions = Reflect.get(
      agent as unknown as Record<string, unknown>,
      '_subscriptions'
    ) as Map<string, { cancel: () => void; promise: Promise<void> }>;
    subscriptions.set('corr-2', { cancel, promise: Promise.resolve() });

    const envelope = {
      frame: { type: 'DeliveryAck', ok: true } satisfies DeliveryAckFrame,
      corrId: 'corr-2',
    } as unknown as FameEnvelope;

    await agent.handleMessage(envelope);
    expect(cancel).not.toHaveBeenCalled();
  });

  test('rejects non-data frames', async () => {
    const agent = new ExampleAgent('frame-check');
    const envelope = {
      frame: { type: 'Other' },
    } as unknown as FameEnvelope;

    await expect(agent.handleMessage(envelope)).rejects.toThrow('Invalid envelope frame');
  });

  test('delegates non-RPC data payloads to onMessage', async () => {
    const agent = new ExampleAgent('message-agent');
    const payload = { hello: 'world' };
    const envelope = createDataEnvelope(payload);

    await agent.handleMessage(envelope);
    expect(agent.onMessagePayloads).toContain(payload);
  });

  test('skips RPC processing when reply target is missing', async () => {
    const agent = new ExampleAgent('rpc-agent');
    const rpcRequest = { jsonrpc: '2.0', method: 'tasks/get', id: '1' };
    const spy = jest
      .spyOn(RpcAdapter, 'handleAgentRpcRequest')
      .mockImplementation(async function* (): AsyncGenerator<JSONRPCResponse> {
        const noop: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: rpcRequest.id ?? null,
          result: null,
        };
        yield noop;
      });

    const envelope = createDataEnvelope(rpcRequest);
    const result = await agent.handleMessage(envelope);

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('streams RPC responses to reply target', async () => {
    const agent = new ExampleAgent('stream-agent');
    const replyTarget = new FameAddress('reply@target');
    const rpcRequest = { jsonrpc: '2.0', method: 'tasks/get', id: 'run' };

    jest.spyOn(RpcAdapter, 'handleAgentRpcRequest').mockImplementation(async function* () {
      yield { jsonrpc: '2.0', id: 'run', result: { ok: true } } as const;
    });

    const envelope = createDataEnvelope(rpcRequest, {
      replyTo: replyTarget,
      traceId: 'trace-id',
    });

    const response = await agent.handleMessage(envelope);
    expect(response).not.toBeNull();

    const messages: FameMessageResponse[] = [];
    for await (const chunk of response as AsyncIterable<FameMessageResponse>) {
      messages.push(chunk);
    }

    expect(messages).toHaveLength(1);
    expect(String(messages[0].envelope.to)).toBe(replyTarget.toString());
  });

  test('treats RPC payload with invalid params as message', async () => {
    const agent = new ExampleAgent('invalid-rpc');
    const rpcLikePayload = {
      jsonrpc: '2.0',
      method: 'demo',
      params: null,
    };

    const onMessageSpy = jest.spyOn(agent, 'onMessage');
    await agent.handleMessage(createDataEnvelope(rpcLikePayload));
    expect(onMessageSpy).toHaveBeenCalledWith(rpcLikePayload);
  });

  test('tasks/sendSubscribe RPC triggers subscription path', async () => {
    const agent = new ExampleAgent('rpc-subscribe');
    const startSpy = jest
      .spyOn(BaseAgent.prototype as any, 'startSubscriptionTask')
      .mockResolvedValue(undefined);

    const envelope = createDataEnvelope(
      { jsonrpc: '2.0', method: 'tasks/sendSubscribe', id: 'abc' },
      { replyTo: new FameAddress('reply@test') }
    );

    const result = await agent.handleMessage(envelope);
    expect(result).toBeNull();
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'tasks/sendSubscribe' }),
      expect.any(String)
    );

    startSpy.mockRestore();
  });
});

describe('BaseAgent subscription handling', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('startSubscriptionTask stores subscription when id present', async () => {
    const agent = new ExampleAgent('sub-agent');
    const streamSpy = jest
      .spyOn(BaseAgent.prototype as any, 'streamSendSubscribe')
      .mockImplementation(async () => undefined);

    const startSubscriptionTask = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'startSubscriptionTask'
    ) as (request: Record<string, unknown>, replyTo: string | FameAddress | null) => Promise<void>;

    await startSubscriptionTask.call(
      agent,
      { jsonrpc: '2.0', method: 'tasks/sendSubscribe', id: 99 },
      new FameAddress('reply@test')
    );

    const subscriptions = Reflect.get(
      agent as unknown as Record<string, unknown>,
      '_subscriptions'
    ) as Map<string, { cancel: () => void; promise: Promise<void> }>;
    expect(subscriptions.has('99')).toBe(true);

    const entry = subscriptions.get('99');
    expect(entry).toBeDefined();
    await entry?.promise;
    expect(subscriptions.has('99')).toBe(false);
    expect(streamSpy).toHaveBeenCalledTimes(1);
    streamSpy.mockRestore();
  });

  test('startSubscriptionTask avoids storing when id missing', async () => {
    const agent = new ExampleAgent('sub-missing');
    const streamSpy = jest
      .spyOn(BaseAgent.prototype as any, 'streamSendSubscribe')
      .mockImplementation(async () => undefined);

    const startSubscriptionTask = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'startSubscriptionTask'
    ) as (request: Record<string, unknown>, replyTo: string | FameAddress | null) => Promise<void>;

    await startSubscriptionTask.call(
      agent,
      { jsonrpc: '2.0', method: 'tasks/sendSubscribe', id: null },
      null
    );

    const subscriptions = Reflect.get(
      agent as unknown as Record<string, unknown>,
      '_subscriptions'
    ) as Map<string, unknown>;
    expect(subscriptions.size).toBe(0);
    streamSpy.mockRestore();
  });

  test('streamSendSubscribe exits early when reply target missing', async () => {
    const agent = new ExampleAgent('stream-missing');

    jest.spyOn(RpcAdapter, 'handleAgentRpcRequest').mockImplementation(async function* () {
      yield { jsonrpc: '2.0', id: '1', result: { chunk: 1 } };
    });

    const sendMock = jest.fn();
    const fabricSpy = jest
      .spyOn(FameFabric, 'current')
      .mockReturnValue({ send: sendMock } as unknown as FameFabric);

    const streamSendSubscribe = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'streamSendSubscribe'
    ) as (
      request: Record<string, unknown>,
      replyTo: string | FameAddress | null,
      signal: AbortSignal
    ) => Promise<void>;

    await streamSendSubscribe.call(
      agent,
      { jsonrpc: '2.0', method: 'tasks/sendSubscribe', id: '1' },
      null,
      new AbortController().signal
    );

    expect(sendMock).not.toHaveBeenCalled();
    fabricSpy.mockRestore();
  });

  test('streamSendSubscribe delivers responses to resolved target', async () => {
    const agent = new ExampleAgent('stream-deliver');

    jest.spyOn(RpcAdapter, 'handleAgentRpcRequest').mockImplementation(async function* () {
      yield { jsonrpc: '2.0', id: '7', result: { chunk: 7 } };
    });

    const sendMock = jest.fn();
    const fabricSpy = jest
      .spyOn(FameFabric, 'current')
      .mockReturnValue({ send: sendMock } as unknown as FameFabric);

    const streamSendSubscribe = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'streamSendSubscribe'
    ) as (
      request: Record<string, unknown>,
      replyTo: string | FameAddress | null,
      signal: AbortSignal
    ) => Promise<void>;

    await streamSendSubscribe.call(
      agent,
      {
        jsonrpc: '2.0',
        method: 'tasks/sendSubscribe',
        id: '7',
        params: { reply_to: 'reply@channel' },
      },
      null,
      new AbortController().signal
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    fabricSpy.mockRestore();
  });

  test('startSubscriptionTask handles stream errors without abort', async () => {
    const agent = new ExampleAgent('sub-error');
    const streamSpy = jest
      .spyOn(BaseAgent.prototype as any, 'streamSendSubscribe')
      .mockRejectedValue(new Error('fail'));

    const startSubscriptionTask = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'startSubscriptionTask'
    ) as (request: Record<string, unknown>, replyTo: string | FameAddress | null) => Promise<void>;

    await startSubscriptionTask.call(
      agent,
      { jsonrpc: '2.0', method: 'tasks/sendSubscribe', id: 'err' },
      null
    );

    const subscriptions = Reflect.get(
      agent as unknown as Record<string, unknown>,
      '_subscriptions'
    ) as Map<string, { cancel: () => void; promise: Promise<void> }>;
    const entry = subscriptions.get('err');
    expect(entry).toBeDefined();
    await entry?.promise;
    expect(subscriptions.has('err')).toBe(false);
    expect(streamSpy).toHaveBeenCalledTimes(1);

    streamSpy.mockRestore();
  });

  test('streamSendSubscribe stops immediately when signal aborted', async () => {
    const agent = new ExampleAgent('stream-aborted');

    const rpcSpy = jest
      .spyOn(RpcAdapter, 'handleAgentRpcRequest')
      .mockImplementation(async function* () {
        yield { jsonrpc: '2.0', id: 'abort', result: { chunk: 1 } };
      });

    const sendMock = jest.fn();
    const fabricSpy = jest
      .spyOn(FameFabric, 'current')
      .mockReturnValue({ send: sendMock } as unknown as FameFabric);

    const streamSendSubscribe = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'streamSendSubscribe'
    ) as (
      request: Record<string, unknown>,
      replyTo: string | FameAddress | null,
      signal: AbortSignal
    ) => Promise<void>;

    const controller = new AbortController();
    controller.abort();

    await streamSendSubscribe.call(
      agent,
      {
        jsonrpc: '2.0',
        method: 'tasks/sendSubscribe',
        id: 'abort',
        params: { reply_to: 'reply@target' },
      },
      null,
      controller.signal
    );

    expect(sendMock).not.toHaveBeenCalled();
    rpcSpy.mockRestore();
    fabricSpy.mockRestore();
  });

  test('streamSendSubscribe rethrows errors when signal active', async () => {
    const agent = new ExampleAgent('stream-error');

    jest.spyOn(RpcAdapter, 'handleAgentRpcRequest').mockImplementation(async function* () {
      throw new Error('boom');
    });

    const streamSendSubscribe = Reflect.get(
      agent as unknown as Record<string, unknown>,
      'streamSendSubscribe'
    ) as (
      request: Record<string, unknown>,
      replyTo: string | FameAddress | null,
      signal: AbortSignal
    ) => Promise<void>;

    await expect(
      streamSendSubscribe.call(
        agent,
        { jsonrpc: '2.0', method: 'tasks/sendSubscribe', id: 'err' },
        new FameAddress('reply@test'),
        new AbortController().signal
      )
    ).rejects.toThrow('boom');
  });
});

describe('BaseAgent task lifecycle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  test('subscribeToTaskUpdates emits on state transitions', async () => {
    const provider = new InMemoryStorageProvider();
    const agent = new ExampleAgent('subscriber', { storageProvider: provider });

    const timeoutSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: any,
      _timeout?: number,
      ...args: any[]
    ) => {
      if (typeof handler === 'function') {
        handler(...args);
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const taskId = 'task-1';
    agent.queueTaskStates([
      makeTask({ id: taskId, state: TaskState.WORKING, payload: 'work' }),
      makeTask({ id: taskId, state: TaskState.WORKING, payload: 'still' }),
      makeTask({ id: taskId, state: TaskState.COMPLETED, payload: 'done' }),
      null,
    ]);

    const params = makeTaskParams({ id: taskId, payload: 'ping' });
    const iterator = agent.subscribeToTaskUpdates(params)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.status.state).toBe(TaskState.WORKING);
    expect(first.value?.final).toBe(false);

    const second = await iterator.next();
    expect(second.value?.status.state).toBe(TaskState.COMPLETED);
    expect(second.value?.final).toBe(true);

    const done = await iterator.next();
    expect(done.done).toBe(true);
    timeoutSpy.mockRestore();
  });

  test('subscribeToTaskUpdates returns immediately when task missing', async () => {
    const provider = new InMemoryStorageProvider();
    const agent = new ExampleAgent('no-task', { storageProvider: provider });
    agent.queueTaskStates([null]);

    const iterator = agent
      .subscribeToTaskUpdates(makeTaskParams({ id: 'missing', payload: 'ping' }))
      [Symbol.asyncIterator]();

    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  test('unsubscribeTask uses unsupported operation guard', async () => {
    const agent = new BaseAgent('base');
    await expect(agent.unsubscribeTask({ id: 'x' } as TaskIdParams)).rejects.toThrow(
      UnsupportedOperationException
    );
  });

  test('cancelTask raises TaskNotCancelableException', async () => {
    const agent = new BaseAgent('base');
    await expect(agent.cancelTask({ id: 'x' } as TaskIdParams)).rejects.toThrow(
      TaskNotCancelableException
    );
  });

  test('registerPushEndpoint rejects by default', async () => {
    const agent = new BaseAgent('base');
    const pushConfig: TaskPushNotificationConfig = {
      id: 'task',
      pushNotificationConfig: {
        url: 'https://example',
        token: null,
        authentication: null,
      },
    };

    await expect(agent.registerPushEndpoint(pushConfig)).rejects.toThrow(
      PushNotificationNotSupportedException
    );
  });

  test('startTask produces completed task from custom runTask', async () => {
    const provider = new InMemoryStorageProvider();
    const agent = new ExampleAgent('runner', { storageProvider: provider });

    const textParams = makeTaskParams({ id: 'text', payload: 'string' });
    const textTask = await agent.startTask(textParams);
    expect(textTask.status.state).toBe(TaskState.COMPLETED);
    expect(agent.lastRun).toMatchObject({ payload: 'string', id: 'text' });

    const dataParams = makeTaskParams({ id: 'obj', payload: { value: 1 } });
    agent.setRunTaskResponse({ ok: true });
    const dataTask = await agent.startTask(dataParams);
    expect(dataTask.status.state).toBe(TaskState.COMPLETED);
    expect(dataTask.status.message?.parts[0]).toMatchObject({ type: 'data' });
  });

  test('startTask fails when no custom runTask provided', async () => {
    const provider = new InMemoryStorageProvider();
    const agent = new BaseAgent('base-run', { storageProvider: provider });

    await expect(agent.startTask(makeTaskParams({ id: 'fail' }))).rejects.toThrow(
      'must implement at least one of: startTask() or runTask()'
    );
  });

  test('runner sanitizes non-object payload to null', async () => {
    const provider = new InMemoryStorageProvider();
    const agent = new ExampleAgent('runner', { storageProvider: provider });
    agent.setRunTaskResponse(42);

    const task = await agent.startTask(makeTaskParams({ id: 'num', payload: 'value' }));
    expect(task.status.message).toBeNull();
  });

  test('authenticate defaults to true', () => {
    const agent = new BaseAgent('auth');
    expect(agent.authenticate({})).toBe(true);
  });

  test('aserve generates name when absent', async () => {
    const agent = new ExampleAgent(null);
    const spy = jest.spyOn(Agent.prototype, 'aserve').mockResolvedValue(undefined);

    const servedAgent = agent as unknown as BaseAgent;
    Reflect.set(servedAgent, '_name', null);

    await servedAgent.aserve(new FameAddress('service@test'));
    expect(servedAgent.name).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
