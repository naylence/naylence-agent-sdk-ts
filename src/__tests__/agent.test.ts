import { jest } from "@jest/globals";
import process from "node:process";
import {
  Agent,
  registerAgentProxyFactory,
  type AgentProxyContract,
  type Payload,
  type Targets,
} from "../naylence/agent/agent.js";
import * as runtime from "naylence-runtime";
import { TaskSendParamsSchema } from "../naylence/agent/a2a-types.js";
import type {
  TaskSendParams,
  TaskQueryParams,
} from "../naylence/agent/a2a-types.js";

const { FameAddress, FameFabric, fabricStack, LogLevel } = runtime;

type FabricLike = InstanceType<typeof FameFabric>;
type AddressLike = InstanceType<typeof FameAddress>;

const signalHandlers: Record<string, (() => void) | undefined> = {};

beforeEach(() => {
  jest
    .spyOn(process, "once")
    .mockImplementation(
      (event: string | symbol, handler: (...args: any[]) => void) => {
        signalHandlers[String(event)] = handler;
        return process;
      },
    );
  jest
    .spyOn(process, "off")
    .mockImplementation(
      (event: string | symbol, handler: (...args: any[]) => void) => {
        const key = String(event);
        if (signalHandlers[key] === handler) {
          delete signalHandlers[key];
        }
        return process;
      },
    );
});

describe("Agent", () => {
  afterEach(() => {
    Object.keys(signalHandlers).forEach((signal) => {
      delete signalHandlers[signal];
    });
    jest.restoreAllMocks();
  });

  it("provides a proxy factory by default", () => {
    const fabric = {
      invoke: jest.fn(),
      invokeByCapability: jest.fn(),
      invokeStream: jest.fn(),
      invokeByCapabilityStream: jest.fn(),
    } as unknown as FabricLike;

    expect(() =>
      Agent.remote({ address: "test@fabric", fabric }),
    ).not.toThrow();
  });

  it("registers proxy factory and resolves address", () => {
    const fabric = {} as FabricLike;
    const proxy: AgentProxyContract = {
      runTask: jest.fn(async () => "ok"),
    };

    const remoteByAddress = jest
      .fn((address: AddressLike, _options: { fabric: FabricLike }) => {
        return proxy;
      })
      .mockName("remoteByAddress") as jest.MockedFunction<
      (
        address: AddressLike,
        options: { fabric: FabricLike },
      ) => AgentProxyContract
    >;

    const remoteByCapabilities = jest
      .fn((capabilities: string[], _options: { fabric: FabricLike }) => {
        return proxy;
      })
      .mockName("remoteByCapabilities") as jest.MockedFunction<
      (
        capabilities: string[],
        options: { fabric: FabricLike },
      ) => AgentProxyContract
    >;

    registerAgentProxyFactory({
      remoteByAddress,
      remoteByCapabilities,
    });

    const resolved = Agent.remote({ address: "agent@fabric", fabric });

    expect(resolved).toBe(proxy);
    expect(remoteByAddress).toHaveBeenCalledWith(
      expect.any(FameAddress),
      expect.objectContaining({ fabric }),
    );
  });

  it("uses capability-based remotes when provided", () => {
    const fabric = {} as FabricLike;
    const proxy: AgentProxyContract = {
      runTask: jest.fn(async () => "ok"),
    };

    const remoteByAddress = jest
      .fn((address: AddressLike, _options: { fabric: FabricLike }) => proxy)
      .mockName("remoteByAddress") as any;
    const remoteByCapabilities = jest
      .fn((capabilities: string[], _options: { fabric: FabricLike }) => proxy)
      .mockName("remoteByCapabilities") as any;

    registerAgentProxyFactory({
      remoteByAddress,
      remoteByCapabilities,
    });

    const resolved = Agent.remote({ capabilities: ["test"], fabric });

    expect(resolved).toBe(proxy);
    expect(remoteByAddress).not.toHaveBeenCalled();
    expect(remoteByCapabilities).toHaveBeenCalledWith(["test"], {
      fabric,
    });
  });

  it("runMany aggregates results and exceptions", async () => {
    const fabric = {} as FabricLike;

    const proxies = new Map<string, jest.Mock>();

    registerAgentProxyFactory({
      remoteByAddress: jest.fn(
        (address: AddressLike, _options: { fabric: FabricLike }) => {
          const name = address.toString();
          const runTask = jest.fn(async (payload: Payload, taskId: string) => {
            if (payload === "fail") {
              throw new Error(`boom:${taskId}`);
            }
            return `${name}:${String(payload)}`;
          });
          proxies.set(name, runTask as jest.Mock);
          return { runTask };
        },
      ) as any,
      remoteByCapabilities: jest.fn(() => {
        throw new Error("capability lookup not expected");
      }) as any,
    });

    const targets: Targets = [
      ["alpha@fabric", "hello"],
      [new FameAddress("beta@fabric"), "fail"],
      ["alpha@fabric", "world"],
    ];

    const results = await Agent.runMany(targets, {
      fabric,
    });

    expect(results).toHaveLength(3);
    expect(results[0][1]).toBe("alpha@fabric:hello");
    expect(results[1][1]).toBeInstanceOf(Error);
    expect((results[1][1] as Error).message).toMatch(/^boom:/);
    expect(results[2][1]).toBe("alpha@fabric:world");

    expect(proxies.get("alpha@fabric")).toHaveBeenCalledTimes(2);

  });

  it("runMany respects gatherExceptions flag", async () => {
    const fabric = {} as FabricLike;

    registerAgentProxyFactory({
      remoteByAddress: jest.fn(() => ({
        runTask: jest.fn(async () => {
          throw new Error("explode");
        }),
      })) as any,
      remoteByCapabilities: jest.fn(() => ({
        runTask: jest.fn(),
      })) as any,
    });

    await expect(
      Agent.runMany([["alpha@fabric", "hello"]], {
        fabric,
        gatherExceptions: false,
      }),
    ).rejects.toThrow("explode");
  });

  it("broadcast maps addresses to targets", async () => {
    const fabric = {} as FabricLike;
    const runTask = jest.fn(async (payload: Payload) => payload);

    registerAgentProxyFactory({
      remoteByAddress: jest.fn(() => ({ runTask })) as any,
      remoteByCapabilities: jest.fn(() => ({
        runTask,
      })) as any,
    });

    const payload = { foo: "bar" };
    const results = await Agent.broadcast(
      ["one@fabric", "two@fabric"],
      payload,
      {
        fabric,
      },
    );

    expect(runTask).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      ["one@fabric", payload],
      ["two@fabric", payload],
    ]);
  });

  it("creates handler-backed agents", async () => {
    const handler = jest.fn(async (payload: Payload, id: string | null) => {
      return `${payload}:${id}`;
    });

    const agent = Agent.fromHandler(handler);

    const params: TaskSendParams = TaskSendParamsSchema.parse({
      id: "task-1",
      message: {
        role: "user",
        parts: [
          {
            type: "text",
            text: "hello",
          },
        ],
      },
    });

    const task = await agent.startTask(params);

    expect(handler).toHaveBeenCalledWith("hello", "task-1");
    expect(task.id).toBe("task-1");
    expect(task.history?.[0]).toEqual({
      role: "agent",
      metadata: null,
      parts: [
        {
          type: "text",
          text: "hello:task-1",
          metadata: null,
        },
      ],
    });
    expect(task.metadata).toBeNull();

    const runResult = await agent.runTask("direct", "42");
    expect(runResult).toBe("direct:42");

    await expect(
      agent.getTaskStatus({ id: "task-1" } as TaskQueryParams),
    ).rejects.toThrow(/Status queries not supported/);
  });

  it("serves agents and configures logging", async () => {
    const agent = Agent.fromHandler(async () => "done");

    const basicConfigSpy = jest
      .spyOn(runtime, "basicConfig")
      .mockImplementation(() => undefined);

    const enter = jest.fn(async () => {});
    const exit = jest.fn(async () => {});
    const serve = jest.fn(async () => {
      signalHandlers.SIGTERM?.();
    });

    const fabric = {
      enter,
      exit,
      serve,
    } as unknown as FabricLike;

    jest.spyOn(runtime.FameFabric, "getOrCreate").mockResolvedValue(fabric);

    fabricStack.splice(0, fabricStack.length);

    await agent.aserve("agent://serve", { logLevel: "debug" });

    expect(basicConfigSpy).toHaveBeenCalledWith({ level: LogLevel.DEBUG });
    expect(serve).toHaveBeenCalledWith(agent, "agent://serve");
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
