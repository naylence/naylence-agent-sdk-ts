import { jest } from "@jest/globals";
import { FameAddress, type FameFabric } from "naylence-runtime";
import { AgentProxy } from "../naylence/agent/agent-proxy.js";
import {
  TaskState,
  type TaskSendParams,
  type Task,
  type TaskStatusUpdateEvent,
  type TaskArtifactUpdateEvent,
} from "../naylence/agent/a2a-types.js";
import { makeTaskParams } from "../naylence/agent/util.js";

type InvokeFn = (...args: any[]) => Promise<any>;
type InvokeStreamFn = (...args: any[]) => Promise<AsyncIterable<any>>;

type FabricMocks = {
  invoke: jest.MockedFunction<InvokeFn>;
  invokeByCapability: jest.MockedFunction<InvokeFn>;
  invokeStream: jest.MockedFunction<InvokeStreamFn>;
  invokeByCapabilityStream: jest.MockedFunction<InvokeStreamFn>;
};

function createFabric(): { fabric: FameFabric; mocks: FabricMocks } {
  const asyncIterable = async function* () {
    void (yield undefined);
  };

  const mocks = {
    invoke: jest.fn(async () => ({})) as jest.MockedFunction<InvokeFn>,
    invokeByCapability: jest.fn(async () => ({})) as jest.MockedFunction<InvokeFn>,
    invokeStream: jest.fn(async () => asyncIterable()) as jest.MockedFunction<InvokeStreamFn>,
    invokeByCapabilityStream: jest.fn(async () => asyncIterable()) as jest.MockedFunction<InvokeStreamFn>,
  } satisfies FabricMocks;

  const fabric = mocks as unknown as FameFabric;
  return { fabric, mocks };
}

function createTask(options: {
  id: string;
  state: TaskState;
  message?: { parts: Array<{ type: "text" | "data"; text?: string | null; data?: Record<string, unknown> | null }>; role?: "user" | "agent" } | null;
}): Task {
  const { id, state, message = null } = options;
  const normalizedMessage = message
    ? {
        role: message.role ?? "agent",
        parts: message.parts.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text ?? null, metadata: null }
            : { type: "data", data: part.data ?? {}, metadata: null }
        ),
        metadata: null,
      }
    : null;

  return {
    id,
    sessionId: id,
    status: {
      state,
      message: normalizedMessage,
      timestamp: new Date(),
    },
    artifacts: null,
    history: normalizedMessage ? [normalizedMessage] : null,
    metadata: null,
  } as Task;
}

describe("AgentProxy", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("startTask delegates to address-bound fabric", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({
      address: new FameAddress("alpha@test"),
      fabric,
    });

    const params = makeTaskParams({ id: "task-1", payload: "hello" });
    (mocks.invoke as jest.Mock).mockImplementation(async () =>
      createTask({ id: "task-2", state: TaskState.COMPLETED })
    );

    const result = await proxy.startTask(params);

    expect(result.status.state).toBe(TaskState.COMPLETED);
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.any(FameAddress),
      "tasks/send",
      expect.objectContaining({ id: "task-1" })
    );
  });

  it("startTask convenience overload routes via capabilities", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({
      capabilities: ["nlp"],
      fabric,
    });

    (mocks.invokeByCapability as jest.Mock).mockImplementation(async () =>
      createTask({ id: "task-2", state: TaskState.COMPLETED })
    );

    const result = await proxy.startTask({
      id: "task-2",
      payload: { topic: "test" },
    });

    expect(result.id).toBe("task-2");
    expect(mocks.invokeByCapability).toHaveBeenCalledWith(
      ["nlp"],
      "tasks/send",
      expect.objectContaining({ id: "task-2" })
    );
  });

  it("runTask returns first text part when task already terminal", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({ address: new FameAddress("beta@test"), fabric });

    (mocks.invoke as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string;
      if (method === "tasks/send") {
        return createTask({
          id: "task-3",
          state: TaskState.COMPLETED,
          message: {
            parts: [{ type: "text", text: "done" }],
          },
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const result = await proxy.runTask("input", null);
    expect(result).toBe("done");
    expect(mocks.invokeStream).not.toHaveBeenCalled();
  });

  it("runTask consumes streaming updates until terminal status", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({ address: new FameAddress("gamma@test"), fabric });

    let unsubscribeCalls = 0;
    (mocks.invoke as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string;
      if (method === "tasks/send") {
        return createTask({ id: "task-4", state: TaskState.WORKING });
      }
      if (method === "tasks/sendUnsubscribe") {
        unsubscribeCalls += 1;
        return null;
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const statusEvent: TaskStatusUpdateEvent = {
      id: "task-4",
      status: {
        state: TaskState.COMPLETED,
        message: {
          role: "agent",
          parts: [{ type: "text", text: "streamed" }],
          metadata: null,
        },
        timestamp: new Date(),
      },
      final: true,
      metadata: null,
    };

    (mocks.invokeStream as jest.Mock).mockImplementation(async () =>
      (async function* () {
        yield statusEvent;
      })()
    );

    const result = await proxy.runTask({ streamed: true }, null);
    expect(result).toEqual("streamed");
    expect(unsubscribeCalls).toBe(1);
  });

  it("runTask raises error when final status failed", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({ address: new FameAddress("delta@test"), fabric });

    (mocks.invoke as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string;
      if (method === "tasks/send") {
        return createTask({ id: "task-5", state: TaskState.WORKING });
      }
      if (method === "tasks/sendUnsubscribe") {
        return null;
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const failureEvent: TaskStatusUpdateEvent = {
      id: "task-5",
      status: {
        state: TaskState.FAILED,
        message: {
          role: "agent",
          parts: [{ type: "text", text: "boom" }],
          metadata: null,
        },
        timestamp: new Date(),
      },
      final: true,
      metadata: null,
    };

    (mocks.invokeStream as jest.Mock).mockImplementation(async () =>
      (async function* () {
        yield failureEvent;
      })()
    );

    await expect(proxy.runTask(null, null)).rejects.toThrow(/boom/);
  });

  it("subscribeToTaskUpdates yields artifact and status events", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({ address: new FameAddress("epsilon@test"), fabric });

    (mocks.invoke as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string;
      if (method === "tasks/sendUnsubscribe") {
        return null;
      }
      if (method === "tasks/send") {
        return createTask({ id: "task-6", state: TaskState.WORKING });
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const artifactEvent: TaskArtifactUpdateEvent = {
      id: "task-6",
      artifact: {
        name: "file",
        description: null,
        parts: [
          {
            type: "text",
            text: "content",
            metadata: null,
          },
        ],
        metadata: null,
        index: 0,
        append: null,
        lastChunk: null,
      },
      metadata: null,
    };

    const statusEvent: TaskStatusUpdateEvent = {
      id: "task-6",
      status: {
        state: TaskState.COMPLETED,
        message: null,
        timestamp: new Date(),
      },
      final: true,
      metadata: null,
    };

    (mocks.invokeStream as jest.Mock).mockImplementation(async () =>
      (async function* () {
        yield artifactEvent;
        yield statusEvent;
      })()
    );

    const updates = await proxy.subscribeToTaskUpdates(
      makeTaskParams({ id: "task-6", payload: "start" })
    );

    const collected: Array<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> = [];
    for await (const item of updates) {
      collected.push(item);
      if ("status" in item && item.status.state === TaskState.COMPLETED) {
        break;
      }
    }

    expect(collected).toHaveLength(2);
    expect(collected[0]).toHaveProperty("artifact");
    expect(collected[1]).toHaveProperty("status");
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.any(FameAddress),
      "tasks/sendUnsubscribe",
      expect.objectContaining({ id: "task-6" })
    );
  });

  it("requires exactly one routing hint", () => {
    const { fabric } = createFabric();

    expect(() => new AgentProxy({ fabric })).toThrow(
      /exactly one of address \| capabilities \| intentNl/,
    );

    expect(
      () =>
        new AgentProxy({
          fabric,
          address: new FameAddress("alpha@test"),
          capabilities: ["test"],
        }),
    ).toThrow(/exactly one/);
  });

  it("throws for unsupported authentication and card retrieval", async () => {
    const { fabric } = createFabric();
    const proxy = new AgentProxy({ address: new FameAddress("theta@test"), fabric });

    await expect(proxy.getAgentCard()).rejects.toThrow(/not yet implemented/);
    expect(() => proxy.authenticate({ schemes: [], credentials: null })).toThrow(
      /Proxy authentication is not supported/,
    );
  });

  it("times out streaming RPCs and unsubscribes", async () => {
    jest.useFakeTimers();
    try {
      const { fabric, mocks } = createFabric();
      const proxy = new AgentProxy({ address: new FameAddress("timeout@test"), fabric });

      let resolveNext: ((value: IteratorResult<unknown>) => void) | null = null;
      const iterator: AsyncIterator<unknown> = {
        next: jest.fn(
          () =>
            new Promise<IteratorResult<unknown>>((resolve) => {
              resolveNext = resolve;
            }),
        ),
        return: jest.fn(async () => {
          resolveNext?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        }),
      };

      mocks.invoke.mockResolvedValue(null);
      const fabricStream: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]: () => iterator,
      };
      mocks.invokeStream.mockResolvedValue(fabricStream);

      const stream = await proxy.subscribeToTaskUpdates(
        makeTaskParams({ id: "timeout", payload: null }),
        { timeoutMs: 5 },
      );

      const iterable = stream[Symbol.asyncIterator]();
      const nextPromise = iterable.next();

      await jest.advanceTimersByTimeAsync(5);
      const result = await nextPromise;

      expect(result.done).toBe(true);
      expect(iterator.return).toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenCalledWith(
        expect.any(FameAddress),
        "tasks/sendUnsubscribe",
        expect.objectContaining({ id: "timeout" })
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("limits streamed items using maxItems", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({ address: new FameAddress("max@test"), fabric });

    const events = [
      { id: "max", status: { state: TaskState.WORKING } },
      { id: "max", status: { state: TaskState.COMPLETED } },
    ];

    mocks.invoke.mockResolvedValue(null);
    const fabricStream: AsyncIterable<{ id: string; status: { state: TaskState } }> = {
      [Symbol.asyncIterator]: () =>
        (async function* () {
          for (const event of events) {
            yield event;
          }
        })()[Symbol.asyncIterator](),
    };
    mocks.invokeStream.mockResolvedValue(fabricStream);

    const stream = await proxy.subscribeToTaskUpdates(
      makeTaskParams({ id: "max", payload: null }),
      { maxItems: 1 },
    );

    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith(
      expect.any(FameAddress),
      "tasks/sendUnsubscribe",
      expect.objectContaining({ id: "max" })
    );
  });

  it("delegates streaming calls for capability-based proxies", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({ capabilities: ["vision"], fabric });

    const capabilityFabricStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () =>
        (async function* () {
          yield {};
        })()[Symbol.asyncIterator](),
    };
    mocks.invokeByCapabilityStream.mockResolvedValue(capabilityFabricStream);

    await (proxy as any)._invokeTarget(
      "tasks/send",
      makeTaskParams({ id: "cap", payload: null }),
      { streaming: true },
    );

    expect(mocks.invokeByCapabilityStream).toHaveBeenCalledWith(
      ["vision"],
      "tasks/send",
      expect.objectContaining({ id: "cap" })
    );
  });

  it("rejects intent-based proxies until implemented", async () => {
    const { fabric } = createFabric();
    const proxy = new AgentProxy({ intentNl: "ask-weather", fabric });

    await expect(
      (proxy as any)._invokeTarget("tasks/send", { id: "intent" }),
    ).rejects.toThrow(/Intent-based routing not yet supported/);
  });

  it("registers and fetches push notification configs via fabric", async () => {
    const { fabric, mocks } = createFabric();
    const proxy = new AgentProxy({ address: new FameAddress("notify@test"), fabric });

    const config = {
      id: "notify",
      pushNotificationConfig: {
        url: "https://callback",
        token: null,
        authentication: null,
      },
    };

    mocks.invoke.mockResolvedValueOnce(config);
    const registered = await proxy.registerPushEndpoint(config);
    expect(registered).toEqual(config);

    mocks.invoke.mockResolvedValueOnce(config);
    const fetched = await proxy.getPushNotificationConfig({
      id: "notify",
      metadata: null,
    });
    expect(fetched).toEqual(config);
  });
});
