import { jest } from '@jest/globals';
import {
  createFameEnvelope,
  type FameEnvelope,
  type FameMessageResponse,
  type JSONRPCResponse,
} from 'naylence-core';
import * as runtime from 'naylence-runtime';
import { BaseAgent, BaseAgentState } from '../naylence/agent/base-agent.js';
import {
  TaskState,
  TaskSendParams,
  type TaskArtifactUpdateEvent,
  type TaskPushNotificationConfig,
  type TaskStatusUpdateEvent,
  type Task,
} from '../naylence/agent/a2a-types.js';
import { makeTask, makeTaskParams } from '../naylence/agent/util.js';
import * as rpcAdapter from '../naylence/agent/rpc-adapter.js';
import { Agent } from '../naylence/agent/agent.js';
import {
  PushNotificationNotSupportedException,
  TaskNotCancelableException,
  UnsupportedOperationException,
} from '../naylence/agent/errors.js';
import type { StorageProvider } from 'naylence-runtime';

const { FameAddress, FameFabric, InMemoryStorageProvider } = runtime;

class RecordingStorageProvider implements StorageProvider {
  readonly namespaces: string[] = [];
  private readonly store = new Map<string, unknown>();

  async getKeyValueStore<V>(_model: new () => V, namespace: string) {
    this.namespaces.push(namespace);
    const backing = this.store as Map<string, V>;
    return {
      set: async (key: string, value: V) => {
        backing.set(key, value);
      },
      update: async (key: string, value: V) => {
        backing.set(key, value);
      },
      get: async (key: string) => backing.get(key),
      delete: async (key: string) => {
        backing.delete(key);
      },
      list: async () => Object.fromEntries(backing.entries()),
    };
  }
}

class CounterState extends BaseAgentState {
  count = 0;
  lastAgentName: string | null = null;

  increment(): void {
    this.count += 1;
    this.lastAgentName = this.getAgent().name;
  }
}

class QueueAgent extends BaseAgent<BaseAgentState> {
  private readonly queue: Array<Task | null>;

  constructor(tasks: Array<Task | null>) {
    super('queue-agent', {
      stateFactory: () => new BaseAgentState(),
      storageProvider: new InMemoryStorageProvider(),
    });
    this.queue = [...tasks];
  }

  override async getTaskStatus(): Promise<Task> {
    const next = this.queue.shift() ?? null;
    return next as unknown as Task;
  }
}

class RunTaskAgent extends BaseAgent<BaseAgentState> {
  readonly runs: Array<{ payload: unknown; id: string | null }> = [];

  constructor() {
    super('run-task-agent', {
      stateFactory: () => new BaseAgentState(),
      storageProvider: new InMemoryStorageProvider(),
    });
  }

  override async runTask(payload: unknown, id: string | null): Promise<unknown> {
    this.runs.push({ payload, id });
    return { echoed: payload };
  }
}

class MessageRecorderAgent extends BaseAgent<BaseAgentState> {
  readonly messages: unknown[] = [];

  constructor() {
    super('recorder-agent', {
      stateFactory: () => new BaseAgentState(),
      storageProvider: new InMemoryStorageProvider(),
    });
  }

  override async onMessage(message: unknown): Promise<FameMessageResponse | null> {
    this.messages.push(message);
    return null;
  }
}

const createDataEnvelope = (payload: unknown): any => ({
  frame: {
    type: 'Data',
    payload,
  },
  corrId: null,
  replyTo: null,
});

describe('BaseAgent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses provided storage provider and persists state updates', async () => {
    const storageProvider = new InMemoryStorageProvider();
    const agent = new BaseAgent<CounterState>('custom-agent', {
      stateModel: CounterState,
      storageProvider,
    });

    const provider = agent.storageProvider;

    expect(provider).toBe(storageProvider);

    await agent.withState(async (state) => {
      state.increment();
    });

    const loaded = await agent.getState();
    expect(loaded.count).toBe(1);
    expect(loaded.lastAgentName).toBe('custom-agent');

    await agent.clearState();
    const reset = await agent.getState();
    expect(reset.count).toBe(0);
    expect(reset.lastAgentName).toBeNull();
  });

  it('throws if storage provider is not supplied', () => {
    const agent = new BaseAgent<CounterState>('missing-provider', {
      stateModel: CounterState,
    });

    expect(() => agent.storageProvider).toThrow('Storage provider is not available');
  });

  it('streams task updates for distinct status changes', async () => {
    jest.useFakeTimers();

    const tasks: Array<Task | null> = [
      makeTask({
        id: 'task-1',
        payload: { step: 1 },
        state: TaskState.WORKING,
        sessionId: 'session',
      }),
      makeTask({
        id: 'task-1',
        payload: { step: 2 },
        state: TaskState.WORKING,
        sessionId: 'session',
      }),
      makeTask({
        id: 'task-1',
        payload: { step: 3 },
        state: TaskState.COMPLETED,
        sessionId: 'session',
      }),
      null,
    ];

    const agent = new QueueAgent(tasks);
    const params: TaskSendParams = makeTaskParams({
      id: 'task-1',
      payload: 'hello',
    });

    const events: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    const iterator = agent.subscribeToTaskUpdates(params);

    const collect = (async () => {
      for await (const event of iterator) {
        events.push(event);
      }
    })();

    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(500);
    await collect;

    expect(events).toHaveLength(2);
    const firstUpdate = events[0] as TaskStatusUpdateEvent;
    const secondUpdate = events[1] as TaskStatusUpdateEvent;
    expect(firstUpdate.status.state).toBe(TaskState.WORKING);
    expect(firstUpdate.final).toBe(false);
    expect(secondUpdate.status.state).toBe(TaskState.COMPLETED);
    expect(secondUpdate.final).toBe(true);
  });

  it('uses runTask fallback when startTask is not overridden', async () => {
    const agent = new RunTaskAgent();
    const params = makeTaskParams({ id: 'run-1', payload: 'payload' });

    const task = await agent.startTask(params);

    expect(agent.runs).toEqual([{ payload: 'payload', id: 'run-1' }]);
    expect(task.status.state).toBe(TaskState.COMPLETED);
    const historyPart = task.history?.[0].parts[0];
    expect(historyPart).toMatchObject({
      type: 'data',
      data: expect.objectContaining({ echoed: 'payload' }),
    });
  });

  it('cancels active subscription when delivery ack fails', async () => {
    const agent = new BaseAgent('ack-agent', {
      stateFactory: () => new CounterState(),
      storageProvider: new InMemoryStorageProvider(),
    });
    const cancel = jest.fn();
    (agent as any)._subscriptions.set('sub-1', {
      cancel,
      promise: Promise.resolve(),
    });

    const envelope = {
      frame: {
        type: 'DeliveryAck',
        ok: false,
      },
      corrId: 'sub-1',
      replyTo: null,
    } as any;

    const result = await agent.handleMessage(envelope);
    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('delegates non-RPC messages to onMessage', async () => {
    const agent = new MessageRecorderAgent();
    const envelope = createDataEnvelope({ message: 'hello' });

    const result = await agent.handleMessage(envelope as any);

    expect(result).toBeNull();
    expect(agent.messages).toEqual([{ message: 'hello' }]);
  });

  it('throws for non-data frames', async () => {
    const agent = new BaseAgent('frame-agent', {
      stateFactory: () => new CounterState(),
      storageProvider: new InMemoryStorageProvider(),
    });

    const envelope = {
      frame: {
        type: 'Heartbeat',
      },
      corrId: null,
      replyTo: null,
    } as any;

    await expect(agent.handleMessage(envelope)).rejects.toThrow(/Invalid envelope frame/);
  });

  it('streams RPC responses to the fabric', async () => {
    const agent = new BaseAgent('rpc-stream', {
      stateFactory: () => new CounterState(),
      storageProvider: new InMemoryStorageProvider(),
    });

    const send = jest.fn(async () => {});
    jest.spyOn(FameFabric, 'current').mockReturnValue({ send } as any);

    const rpcSpy = jest.spyOn(rpcAdapter, 'handleAgentRpcRequest');
    rpcSpy.mockImplementationOnce(async function* (): AsyncGenerator<JSONRPCResponse> {
      const first: JSONRPCResponse = { jsonrpc: '2.0', id: 'rpc-1', result: 'first' };
      yield first;
      const second: JSONRPCResponse = { jsonrpc: '2.0', id: 'rpc-1', result: 'second' };
      yield second;
    });

    await (agent as any).streamSendSubscribe(
      {
        jsonrpc: '2.0',
        method: 'tasks/sendSubscribe',
        id: 'rpc-1',
        params: { reply_to: 'reply@fabric' },
      },
      'reply@fabric',
      new globalThis.AbortController().signal
    );

    expect(send).toHaveBeenCalledTimes(2);
    const firstCall = send.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [firstEnvelope] = firstCall as unknown as [FameEnvelope];
    expect(firstEnvelope.corrId).toBe('rpc-1');
    expect(firstEnvelope.to).toBeInstanceOf(FameAddress);
    expect(firstEnvelope.to?.toString()).toBe('reply@fabric');

    rpcSpy.mockImplementationOnce(async function* (): AsyncGenerator<JSONRPCResponse> {
      const ignored: JSONRPCResponse = { jsonrpc: '2.0', id: 'rpc-2', result: 'ignored' };
      yield ignored;
    });

    send.mockClear();

    await (agent as any).streamSendSubscribe(
      {
        jsonrpc: '2.0',
        method: 'tasks/sendSubscribe',
        id: 'rpc-2',
        params: {},
      },
      null,
      new globalThis.AbortController().signal
    );

    expect(send).not.toHaveBeenCalled();
  });

  it('handles subscribe RPC envelopes and cleans up subscriptions', async () => {
    const agent = new BaseAgent('rpc-agent', {
      stateFactory: () => new CounterState(),
      storageProvider: new InMemoryStorageProvider(),
    });

    const send = jest.fn(async () => {});
    jest.spyOn(FameFabric, 'current').mockReturnValue({ send } as any);

    jest
      .spyOn(rpcAdapter, 'handleAgentRpcRequest')
      .mockImplementation(async function* (): AsyncGenerator<JSONRPCResponse> {
        const payload: JSONRPCResponse = { jsonrpc: '2.0', id: 'rpc-3', result: 'payload' };
        yield payload;
      });

    const envelope = createFameEnvelope({
      frame: {
        type: 'Data',
        payload: {
          jsonrpc: '2.0',
          method: 'tasks/sendSubscribe',
          id: 'rpc-3',
          params: { reply_to: 'reply@fabric' },
        },
      },
      to: new FameAddress('test@fabric'),
    });

    await agent.handleMessage(envelope);

    const subscriptions: Map<string, { promise: Promise<void> }> = (agent as any)._subscriptions;
    await Promise.all(Array.from(subscriptions.values(), ({ promise }) => promise.catch(() => {})));

    expect(send).toHaveBeenCalledTimes(1);
    expect(subscriptions.size).toBe(0);
  });

  it('falls back to params when replyTo header is missing', async () => {
    const agent = new BaseAgent('rpc-target', {
      stateFactory: () => new CounterState(),
      storageProvider: new InMemoryStorageProvider(),
    });

    jest
      .spyOn(rpcAdapter, 'handleAgentRpcRequest')
      .mockImplementationOnce(async function* (): AsyncGenerator<JSONRPCResponse> {
        const ok: JSONRPCResponse = { jsonrpc: '2.0', id: 'rpc-4', result: 'ok' };
        yield ok;
      });

    const responses = await agent.handleMessage(
      createFameEnvelope({
        frame: {
          type: 'Data',
          payload: {
            jsonrpc: '2.0',
            method: 'custom',
            id: 'rpc-4',
            params: { reply_to: 'reply@fabric' },
          },
        },
        to: new FameAddress('source@fabric'),
      })
    );

    const yielded: FameMessageResponse[] = [];
    if (responses && Symbol.asyncIterator in responses) {
      for await (const message of responses as AsyncIterable<FameMessageResponse>) {
        yielded.push(message);
      }
    }

    expect(yielded).toHaveLength(1);
  });

  it('generates a name when serving anonymously', async () => {
    const agent = new BaseAgent('served-agent', {
      stateFactory: () => new CounterState(),
      storageProvider: new InMemoryStorageProvider(),
    });
    (agent as any)._name = null;

    const generateSpy = jest.spyOn(runtime, 'generateId').mockReturnValue('generated-id');
    jest.spyOn(Agent.prototype, 'aserve').mockResolvedValue();

    await agent.aserve('agent://service');

    expect(generateSpy).toHaveBeenCalled();
    expect(agent.name).toBe('generated-id');
  });

  it('derives default name and sanitizes generated namespaces', async () => {
    class XMLAgent extends BaseAgent<BaseAgentState> {
      constructor(provider: StorageProvider) {
        super(null, {
          stateFactory: () => new BaseAgentState(),
          stateModel: BaseAgentState,
          stateNamespace: '***',
          storageProvider: provider,
        });
      }
    }

    const provider = new RecordingStorageProvider();
    const agent = new XMLAgent(provider);

    expect(agent.name).toBe('xml_agent');
    await agent.withState(async () => {});
    expect(provider.namespaces).toContain('ns');
  });

  it('exposes immutable capability and address metadata', () => {
    const agent = new BaseAgent('caps-agent', {
      stateFactory: () => new BaseAgentState(),
      storageProvider: new InMemoryStorageProvider(),
    });

    const capabilities = agent.capabilities;
    capabilities.push('mutated');
    expect(agent.capabilities).not.toContain('mutated');

    const address = new FameAddress('caps@test');
    agent.address = address;
    expect(agent.address).toBe(address);
    expect(agent.spec.address).toBe(address.toString());
  });

  it('implements default authentication and unsupported operations', async () => {
    const agent = new BaseAgent('defaults', {
      stateFactory: () => new BaseAgentState(),
      storageProvider: new InMemoryStorageProvider(),
    });

    expect(agent.authenticate({})).toBe(true);

    const pushConfig: TaskPushNotificationConfig = {
      id: 'task-123',
      pushNotificationConfig: {
        url: 'https://callback',
        token: null,
        authentication: null,
      },
    };

    await expect(agent.registerPushEndpoint(pushConfig)).rejects.toBeInstanceOf(
      PushNotificationNotSupportedException
    );
    await expect(
      agent.getPushNotificationConfig({
        id: 'task-123',
        metadata: null,
      })
    ).rejects.toBeInstanceOf(PushNotificationNotSupportedException);

    await expect(agent.unsubscribeTask({ id: 'task-123', metadata: null })).rejects.toBeInstanceOf(
      UnsupportedOperationException
    );
    await expect(agent.cancelTask({ id: 'task-123', metadata: null })).rejects.toBeInstanceOf(
      TaskNotCancelableException
    );
    await expect(agent.getAgentCard()).rejects.toBeInstanceOf(UnsupportedOperationException);
    await expect(agent.getTaskStatus({ id: 'task-123', metadata: null })).rejects.toBeInstanceOf(
      UnsupportedOperationException
    );
    await expect(agent.runTask(null, null)).rejects.toBeInstanceOf(UnsupportedOperationException);
  });

  it('logs unhandled messages via default onMessage', async () => {
    const agent = new BaseAgent('logger', {
      stateFactory: () => new BaseAgentState(),
      storageProvider: new InMemoryStorageProvider(),
    });

    const result = await BaseAgent.prototype.onMessage.call(agent, {
      hello: 'world',
    });

    expect(result).toBeNull();
  });

  it('throws when no state model or factory is configured', () => {
    const agent = new BaseAgent('stateless');
    expect(() => agent.state).toThrow('No state model configured');
  });
});
