import { JSONRPCRequestSchema, type JSONRPCResponse } from 'naylence-core';
import { handleAgentRpcRequest } from '../naylence/agent/rpc-adapter.js';
import { makeTask, makeTaskParams } from '../naylence/agent/util.js';
import {
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  TaskPushNotificationConfig,
  TaskIdParams,
} from '../naylence/agent/a2a-types.js';
import { A2ARequestSchema } from '../naylence/agent/a2a-types.js';
import type { Agent } from '../naylence/agent/agent.js';
import {
  AgentException,
  AuthorizationException,
  DuplicateTaskException,
  InvalidDataException,
  InvalidTaskException,
  NoDataFoundException,
  PushNotificationNotSupportedException,
  RateLimitExceededException,
  TaskNotCancelableException,
  UnsupportedOperationException,
} from '../naylence/agent/errors.js';

type RpcRegistryEntry = { propertyKey: string; streaming: boolean };

interface MockAgent {
  agent: Agent;
  registry: Map<string, RpcRegistryEntry>;
  mocks: {
    startTask: jest.Mock;
    getTaskStatus: jest.Mock;
    cancelTask: jest.Mock;
    registerPushEndpoint: jest.Mock;
    getPushNotificationConfig: jest.Mock;
    getAgentCard: jest.Mock;
    subscribeToTaskUpdates: jest.Mock;
    unsubscribeTask: jest.Mock;
  };
}

const JSONRPC_VERSION = '2.0';

function createMockAgent(overrides: Partial<MockAgent['mocks']> = {}): MockAgent {
  const startTask = overrides.startTask ?? jest.fn();
  const getTaskStatus = overrides.getTaskStatus ?? jest.fn();
  const cancelTask = overrides.cancelTask ?? jest.fn();
  const registerPushEndpoint = overrides.registerPushEndpoint ?? jest.fn();
  const getPushNotificationConfig = overrides.getPushNotificationConfig ?? jest.fn();
  const getAgentCard = overrides.getAgentCard ?? jest.fn();
  const subscribeToTaskUpdates = overrides.subscribeToTaskUpdates ?? jest.fn();
  const unsubscribeTask = overrides.unsubscribeTask ?? jest.fn();

  const registry = new Map<string, RpcRegistryEntry>();

  const agent: Record<string, unknown> = {
    name: null,
    spec: {},
    authenticate: jest.fn(() => true),
    startTask,
    getTaskStatus,
    cancelTask,
    registerPushEndpoint,
    getPushNotificationConfig,
    getAgentCard,
    subscribeToTaskUpdates,
    unsubscribeTask,
  };

  Object.defineProperty(agent, 'constructor', {
    value: { rpcRegistry: registry },
  });

  const typedAgent = agent as unknown as Agent;

  return {
    agent: typedAgent,
    registry,
    mocks: {
      startTask,
      getTaskStatus,
      cancelTask,
      registerPushEndpoint,
      getPushNotificationConfig,
      getAgentCard,
      subscribeToTaskUpdates,
      unsubscribeTask,
    },
  };
}

function setAgentProperty(agent: Agent, key: string, value: unknown): void {
  (agent as unknown as Record<string, unknown>)[key] = value;
}

async function collectResponses(generator: AsyncGenerator<unknown>): Promise<Array<any>> {
  const responses: Array<any> = [];
  for await (const item of generator) {
    responses.push(item);
  }
  return responses;
}

function createRequest(
  method: string,
  params?: unknown,
  id: string | number | null = 'req-1'
): Record<string, unknown> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    method,
    params,
  };
}

describe('handleAgentRpcRequest - A2A methods', () => {
  it('returns invalid request error when payload schema fails', async () => {
    const { agent } = createMockAgent();

    const responses = await collectResponses(
      handleAgentRpcRequest(agent, null as unknown as Record<string, unknown>)
    );

    expect(responses).toEqual([
      expect.objectContaining({
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: expect.objectContaining({ code: -32600 }),
      }),
    ]);
  });

  it('yields invalid request error when A2A schema validation fails', async () => {
    const { agent, mocks } = createMockAgent();

    const invalidRequest = {
      jsonrpc: JSONRPC_VERSION,
      id: 'bad-params',
      method: 'tasks/send',
      params: { unexpected: true },
    } satisfies Record<string, unknown>;

    const responses = await collectResponses(handleAgentRpcRequest(agent, invalidRequest));

    expect(mocks.startTask).not.toHaveBeenCalled();
    expect(responses[0]).toEqual(
      expect.objectContaining({
        id: 'bad-params',
        error: expect.objectContaining({ code: -32600 }),
      })
    );
  });

  it('routes tasks/send and serializes task results', async () => {
    const { agent, mocks } = createMockAgent();
    const task = makeTask({ id: 'task-1', payload: 'done' });
    mocks.startTask.mockResolvedValue(task);

    const params = makeTaskParams({ id: 'task-1', payload: 'done' });
    const request = createRequest('tasks/send', params, 'send-1');

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(mocks.startTask).toHaveBeenCalledWith(params);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual(
      expect.objectContaining({
        id: 'send-1',
        result: expect.objectContaining({ id: 'task-1' }),
      })
    );
  });

  it('returns null when task status lookup yields no task', async () => {
    const { agent, mocks } = createMockAgent();
    mocks.getTaskStatus.mockResolvedValue(null);

    const params = { id: 'task-404' } satisfies TaskIdParams;
    const request = createRequest('tasks/get', params, 'get-1');

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(mocks.getTaskStatus).toHaveBeenCalledWith(params);
    expect(responses[0]).toEqual(expect.objectContaining({ id: 'get-1', result: null }));
  });

  it('serializes task status when lookup succeeds', async () => {
    const { agent, mocks } = createMockAgent();
    const task = makeTask({ id: 'task-200', payload: { ok: true } });
    mocks.getTaskStatus.mockResolvedValue(task);

    const params = { id: 'task-200' } satisfies TaskIdParams;
    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('tasks/get', params, 'get-2'))
    );

    expect(mocks.getTaskStatus).toHaveBeenCalledWith(params);
    expect(responses[0]).toEqual(
      expect.objectContaining({
        id: 'get-2',
        result: expect.objectContaining({ id: 'task-200' }),
      })
    );
  });

  it('serializes cancel results when available', async () => {
    const { agent, mocks } = createMockAgent();
    const task = makeTask({ id: 'task-cancel', payload: 'stopped' });
    mocks.cancelTask.mockResolvedValue(task);

    const params = { id: 'task-cancel' } satisfies TaskIdParams;
    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('tasks/cancel', params, 'cancel-1'))
    );

    expect(mocks.cancelTask).toHaveBeenCalledWith(params);
    expect(responses[0]).toEqual(
      expect.objectContaining({
        id: 'cancel-1',
        result: expect.objectContaining({ id: 'task-cancel' }),
      })
    );
  });

  it('defaults to null id and result when cancel returns nothing', async () => {
    const { agent, mocks } = createMockAgent();
    mocks.cancelTask.mockResolvedValue(null);

    const params = { id: 'task-null' } satisfies TaskIdParams;
    const request = createRequest('tasks/cancel', params, null);

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(mocks.cancelTask).toHaveBeenCalledWith(params);
    expect(responses[0]).toEqual(expect.objectContaining({ id: null, result: null }));
  });

  it('serializes streaming updates and artifacts', async () => {
    const { agent, mocks } = createMockAgent();
    const statusEvent: TaskStatusUpdateEvent = {
      id: 'task-stream',
      status: {
        state: TaskState.WORKING,
        message: null,
        timestamp: new Date(),
      },
      final: false,
      metadata: null,
    };
    const artifactEvent: TaskArtifactUpdateEvent = {
      id: 'task-stream',
      artifact: {
        name: 'partial',
        description: null,
        parts: [],
        metadata: null,
        index: 0,
        append: null,
        lastChunk: null,
      },
      metadata: null,
    };

    mocks.subscribeToTaskUpdates.mockResolvedValue(
      (async function* () {
        yield statusEvent;
        yield artifactEvent;
      })()
    );

    const params = makeTaskParams({ id: 'task-stream', payload: null });
    const request = createRequest('tasks/sendSubscribe', params, 'sub-1');

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(responses).toHaveLength(3);
    expect(responses[0]).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          id: 'task-stream',
          status: expect.objectContaining({ state: TaskState.WORKING }),
        }),
      })
    );
    expect(responses[1]).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          artifact: expect.objectContaining({ name: 'partial' }),
        }),
      })
    );
    expect(responses[2]).toEqual(expect.objectContaining({ result: null }));
  });

  it('delegates unsubscribe requests', async () => {
    const { agent, mocks } = createMockAgent();
    mocks.unsubscribeTask.mockResolvedValue(undefined);

    const params = { id: 'task-stop' } satisfies TaskIdParams;
    const request = createRequest('tasks/sendUnsubscribe', params, 'unsub');

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(mocks.unsubscribeTask).toHaveBeenCalledWith(params);
    expect(responses[0]).toEqual(expect.objectContaining({ id: 'unsub', result: null }));
  });

  it('yields method not found error for unsupported A2A method', async () => {
    const { agent } = createMockAgent();

    const request = createRequest('tasks/unknown', {});
    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(responses[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32601 }),
      })
    );
  });

  it('returns method not found for tasks/resubscribe', async () => {
    const { agent } = createMockAgent();

    const request = createRequest('tasks/resubscribe', { id: 'task-1' });
    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(responses[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32601 }),
      })
    );
  });

  it('returns registered push notification configuration result', async () => {
    const { agent, mocks } = createMockAgent();
    const config: TaskPushNotificationConfig = {
      id: 'task-push',
      pushNotificationConfig: {
        url: 'https://callback',
        token: null,
        authentication: null,
      },
    };
    mocks.registerPushEndpoint.mockResolvedValue(config);

    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('tasks/pushNotification/set', config, 'push-set'))
    );

    expect(responses[0]).toEqual(
      expect.objectContaining({
        id: 'push-set',
        result: config,
      })
    );
  });

  it('coerces undefined push registration result to null', async () => {
    const { agent, mocks } = createMockAgent();
    const config: TaskPushNotificationConfig = {
      id: 'task-push',
      pushNotificationConfig: {
        url: 'https://callback',
        token: null,
        authentication: null,
      },
    };
    mocks.registerPushEndpoint.mockResolvedValue(undefined);

    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('tasks/pushNotification/set', config, null))
    );

    expect(mocks.registerPushEndpoint).toHaveBeenCalledWith(config);
    expect(responses[0]).toEqual(expect.objectContaining({ id: null, result: null }));
  });

  it('returns stored push notification config or null', async () => {
    const { agent, mocks } = createMockAgent();
    const config: TaskPushNotificationConfig = {
      id: 'task-push',
      pushNotificationConfig: {
        url: 'https://stored',
        token: 'token',
        authentication: null,
      },
    };
    mocks.getPushNotificationConfig.mockResolvedValueOnce(config);
    mocks.getPushNotificationConfig.mockResolvedValueOnce(undefined);

    const responses = await collectResponses(
      handleAgentRpcRequest(
        agent,
        createRequest('tasks/pushNotification/get', { id: 'task-push' }, 'push-get')
      )
    );

    expect(responses[0]).toEqual(
      expect.objectContaining({
        id: 'push-get',
        result: config,
      })
    );

    const second = await collectResponses(
      handleAgentRpcRequest(
        agent,
        createRequest('tasks/pushNotification/get', { id: 'task-push' }, 'push-null')
      )
    );

    expect(second[0]).toEqual(
      expect.objectContaining({
        id: 'push-null',
        result: null,
      })
    );
  });

  it('returns agent card from remote agent', async () => {
    const { agent, mocks } = createMockAgent();
    const card = { name: 'Demo', url: 'https://docs', version: '1.0.0' };
    mocks.getAgentCard.mockResolvedValue(card);
    const parseSpy = jest.spyOn(A2ARequestSchema, 'parse').mockImplementation(
      (request: unknown) =>
        ({
          ...(request as Record<string, unknown>),
          method: 'agent.get_card',
          params: {},
        }) as any
    );

    try {
      const responses = await collectResponses(
        handleAgentRpcRequest(agent, createRequest('agent.get_card', {}, 'card'))
      );

      expect(responses[0]).toEqual(expect.objectContaining({ id: 'card', result: card }));
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe('handleAgentRpcRequest - generic parsing', () => {
  it('includes string errors when request parsing fails', async () => {
    const parseSpy = jest.spyOn(JSONRPCRequestSchema, 'parse').mockImplementation(() => {
      throw 'bad';
    });

    const { agent } = createMockAgent();

    try {
      const responses = await collectResponses(
        handleAgentRpcRequest(agent, { something: true } as any)
      );

      expect(responses[0]).toEqual(
        expect.objectContaining({
          id: null,
          error: expect.objectContaining({ code: -32600 }),
        })
      );
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe('handleAgentRpcRequest - error mapping', () => {
  const pushConfig: TaskPushNotificationConfig = {
    id: 'task-error',
    pushNotificationConfig: {
      url: 'https://callback',
      token: null,
      authentication: null,
    },
  };

  function paramsFor(method: string): unknown {
    switch (method) {
      case 'tasks/get':
        return { id: 'task-error' } satisfies TaskIdParams;
      case 'tasks/cancel':
        return { id: 'task-error' } satisfies TaskIdParams;
      case 'tasks/pushNotification/set':
        return pushConfig;
      default:
        return makeTaskParams({ id: 'task-error', payload: null });
    }
  }

  it.each([
    {
      name: 'invalid task',
      method: 'tasks/send',
      error: new InvalidTaskException('missing parts'),
      expected: { code: -32602 },
    },
    {
      name: 'duplicate task',
      method: 'tasks/send',
      error: new DuplicateTaskException('exists'),
      expected: { code: -32602 },
    },
    {
      name: 'no data',
      method: 'tasks/get',
      error: new NoDataFoundException('gone'),
      expected: { code: -32602 },
    },
    {
      name: 'invalid data',
      method: 'tasks/pushNotification/set',
      error: new InvalidDataException('bad'),
      expected: { code: -32602 },
    },
    {
      name: 'task not cancelable',
      method: 'tasks/cancel',
      error: new TaskNotCancelableException('locks'),
      expected: { code: -32002 },
    },
    {
      name: 'push not supported',
      method: 'tasks/pushNotification/set',
      error: new PushNotificationNotSupportedException('no'),
      expected: { code: -32003 },
    },
    {
      name: 'unsupported operation',
      method: 'tasks/send',
      error: new UnsupportedOperationException('legacy'),
      expected: { code: -32004 },
    },
    {
      name: 'authorization',
      method: 'tasks/send',
      error: new AuthorizationException('denied'),
      expected: { code: -32600, data: 'denied' },
    },
    {
      name: 'rate limit',
      method: 'tasks/send',
      error: new RateLimitExceededException('slow'),
      expected: { code: -32029 },
    },
    {
      name: 'agent exception',
      method: 'tasks/send',
      error: new AgentException('internal'),
      expected: { code: -32603 },
    },
    {
      name: 'unknown thrown value',
      method: 'tasks/send',
      error: 'boom',
      expected: { code: -32603 },
    },
    {
      name: 'generic error object',
      method: 'tasks/send',
      error: new Error('generic failure'),
      expected: { code: -32603 },
    },
  ])('maps $name errors to RPC responses', async ({ method, error, expected }) => {
    const { agent, mocks } = createMockAgent();

    switch (method) {
      case 'tasks/get': {
        mocks.getTaskStatus.mockRejectedValue(error);
        break;
      }
      case 'tasks/cancel': {
        mocks.cancelTask.mockRejectedValue(error);
        break;
      }
      case 'tasks/pushNotification/set': {
        mocks.registerPushEndpoint.mockRejectedValue(error);
        break;
      }
      default: {
        mocks.startTask.mockRejectedValue(error);
      }
    }

    const request = createRequest(method, paramsFor(method), 'err');

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    const [response] = responses as JSONRPCResponse[];
    expect(response.error?.code).toBe(expected.code);
    if (Object.prototype.hasOwnProperty.call(expected, 'data')) {
      expect(response.error?.data).toBe(expected.data);
    }
  });
});

describe('handleAgentRpcRequest - custom registry', () => {
  it('returns method not found when registry has no entry', async () => {
    const { agent } = createMockAgent();

    const request = createRequest('custom/echo', { value: 1 });
    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(responses[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32601 }),
      })
    );
  });

  it('handles agents without registry metadata', async () => {
    const { agent } = createMockAgent();
    const ctor = agent.constructor as {
      rpcRegistry?: Map<string, RpcRegistryEntry>;
    };
    delete ctor.rpcRegistry;

    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('custom/missing', { value: true }))
    );

    expect(responses[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32601 }),
      })
    );
  });

  it('reports internal error when handler is not callable', async () => {
    const { agent, registry } = createMockAgent();
    registry.set('custom/bad', { propertyKey: 'bad', streaming: false });
    setAgentProperty(agent, 'bad', 42);

    const request = createRequest('custom/bad', {});
    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(responses[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32603 }),
      })
    );
  });

  it('invokes streaming handlers with args and kwargs', async () => {
    const { agent, registry } = createMockAgent();
    registry.set('custom/stream', {
      propertyKey: 'handleStream',
      streaming: true,
    });

    const handler = jest.fn(async function* (first: number, options: Record<string, unknown>) {
      yield { first, options };
    });
    setAgentProperty(agent, 'handleStream', handler);

    const request = createRequest('custom/stream', {
      args: [7],
      kwargs: { limit: 1 },
    });

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(handler).toHaveBeenCalledWith(7, { limit: 1 });
    expect(responses).toEqual([
      expect.objectContaining({
        result: { first: 7, options: { limit: 1 } },
      }),
      expect.objectContaining({ result: null }),
    ]);
  });

  it('invokes streaming handlers without kwargs', async () => {
    const { agent, registry } = createMockAgent();
    registry.set('custom/stream-lite', {
      propertyKey: 'handleLite',
      streaming: true,
    });

    const handler = jest.fn(async function* (value: number) {
      yield value;
    });
    setAgentProperty(agent, 'handleLite', handler);

    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('custom/stream-lite', { args: [99] }, 'lite'))
    );

    expect(handler).toHaveBeenCalledWith(99);
    expect(responses).toEqual([
      expect.objectContaining({ result: 99 }),
      expect.objectContaining({ result: null }),
    ]);
  });

  it('normalizes params object into kwargs when args missing', async () => {
    const { agent, registry } = createMockAgent();
    registry.set('custom/sum', { propertyKey: 'sum', streaming: false });

    const sum = jest.fn(({ a, b }: { a: number; b: number }) => a + b);
    setAgentProperty(agent, 'sum', sum);

    const request = createRequest('custom/sum', { a: 2, b: 3 });
    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(sum).toHaveBeenCalledWith({ a: 2, b: 3 });
    expect(responses[0]).toEqual(expect.objectContaining({ result: 5 }));
  });

  it('handles handlers that throw errors', async () => {
    const { agent, registry } = createMockAgent();
    registry.set('custom/fail', { propertyKey: 'fail', streaming: false });

    const fail = jest.fn(() => {
      throw new Error('boom');
    });
    setAgentProperty(agent, 'fail', fail);

    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('custom/fail', null))
    );

    expect(fail).toHaveBeenCalledWith();
    expect(responses[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32603 }),
      })
    );
  });

  it('propagates null id and result when handler resolves undefined', async () => {
    const { agent, registry } = createMockAgent();
    registry.set('custom/optional', {
      propertyKey: 'maybe',
      streaming: false,
    });

    const maybe = jest.fn(async () => undefined);
    setAgentProperty(agent, 'maybe', maybe);

    const request = {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      method: 'custom/optional',
      params: { args: [1, 2] },
    } satisfies Record<string, unknown>;

    const responses = await collectResponses(handleAgentRpcRequest(agent, request));

    expect(maybe).toHaveBeenCalledWith(1, 2);
    expect(responses[0]).toEqual(expect.objectContaining({ id: null, result: null }));
  });

  it('maps non-error throws from custom handlers', async () => {
    const { agent, registry } = createMockAgent();
    registry.set('custom/no-error', {
      propertyKey: 'noError',
      streaming: false,
    });

    const noError = jest.fn(() => {
      throw 'boom';
    });
    setAgentProperty(agent, 'noError', noError);

    const responses = await collectResponses(
      handleAgentRpcRequest(agent, createRequest('custom/no-error', {}))
    );

    expect(responses[0]).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: -32603 }),
      })
    );
  });
});
