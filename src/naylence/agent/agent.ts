import {
  FameAddress,
  FameFabric,
  basicConfig,
  fabricStack,
  generateId,
  getLogger,
  LogLevel,
} from "naylence-runtime";
import { RpcMixin } from "naylence-runtime";
import type { FameService } from "naylence-core";
import { TaskState } from "./a2a-types.js";
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
} from "./a2a-types.js";
import { makeTask } from "./util.js";
import { resolveAgentProxyCtor } from "./agent-proxy-registry.js";
import "./agent-proxy-default.js";
export { registerAgentProxyFactory } from "./agent-proxy-registry.js";
export type { AgentProxyConstructor } from "./agent-proxy-registry.js";

const logger = getLogger("naylence.agent.agent");

export type Payload = Record<string, unknown> | string | null;
export type Targets = Iterable<readonly [FameAddress | string, Payload]>;

type AgentTaskHandler = (
  payload: Payload,
  id: string | null,
) => unknown | Promise<unknown>;

type AgentTaskResult<TAgent extends Agent> = Awaited<
  ReturnType<TAgent["runTask"]>
>;

export interface AgentProxyContract<TAgent extends Agent = Agent> {
  runTask(
    payload: Payload,
    id: string | null,
  ): Promise<AgentTaskResult<TAgent>>;
}

const isNodeRuntime = (): boolean =>
  typeof process !== "undefined" && process.release?.name === "node";

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
  if (typeof level === "number") {
    if (Object.values(LogLevel).includes(level)) {
      return level as LogLevel;
    }
    throw new Error(`Unsupported numeric log level: ${level}`);
  }

  if (typeof level === "string") {
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

  const { default: process } = await import("node:process");
  const handler = () => stop.resolve();

  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);

  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
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
        logger.warning("fabric_exit_failed", { error });
      }
    },
  };
}

function toFameAddress(value: FameAddress | string): FameAddress {
  return value instanceof FameAddress ? value : new FameAddress(String(value));
}

function invokeProxyRunTask(
  proxy: AgentProxyContract,
  payload: Payload,
  taskId: string,
): Promise<any> {
  if (typeof proxy.runTask === "function") {
    return proxy.runTask(payload, taskId);
  }
  throw new Error("AgentProxy must implement runTask");
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
   * Options forwarded directly to {@link FameFabric.getOrCreate}. This mirrors the Python
   * implementation's ``**kwargs`` so existing keyword-based configurations remain compatible.
   */
  fabricOptions?: Record<string, unknown>;
  logLevel?: string | number | LogLevel | null;
}

export abstract class Agent extends RpcMixin implements FameService {
  abstract get name(): string | null;

  abstract get spec(): Record<string, unknown>;

  abstract getAgentCard(): Promise<AgentCard>;

  abstract authenticate(credentials: AuthenticationInfo): boolean;

  abstract startTask(params: TaskSendParams): Promise<Task>;

  abstract runTask(payload: Payload, id: string | null): Promise<any>;

  abstract getTaskStatus(params: TaskQueryParams): Promise<Task>;

  abstract cancelTask(params: TaskIdParams): Promise<Task>;

  abstract subscribeToTaskUpdates(
    params: TaskSendParams,
  ): AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>;

  abstract unsubscribeTask(params: TaskIdParams): Promise<any>;

  abstract registerPushEndpoint(
    config: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig>;

  abstract getPushNotificationConfig(
    params: TaskIdParams,
  ): Promise<TaskPushNotificationConfig>;

  static remote<TAgent extends Agent>(
    this: typeof Agent,
    options: AgentRemoteOptions,
  ): AgentProxyContract<TAgent> {
    const { address, capabilities, fabric } = options;
    const selected = Number(address != null) + Number(capabilities != null);

    if (selected !== 1) {
      throw new Error("Provide exactly one of address | capabilities");
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
    options: { fabric?: FameFabric } = {},
  ): AgentProxyContract<TAgent> {
    return this.remote<TAgent>({ address, fabric: options.fabric });
  }

  static remoteByCapabilities<TAgent extends Agent>(
    this: typeof Agent,
    capabilities: string[],
    options: { fabric?: FameFabric } = {},
  ): AgentProxyContract<TAgent> {
    return this.remote<TAgent>({ capabilities, fabric: options.fabric });
  }

  static fromHandler(handler: AgentTaskHandler): Agent {
    const normalizedHandler: AgentTaskHandler = async (payload, id) =>
      handler(payload, id);

    class HandlerAgent extends Agent {
      #name = generateId();

      get name(): string | null {
        return this.#name;
      }

      get spec(): Record<string, unknown> {
        return {};
      }

      async getAgentCard(): Promise<AgentCard> {
        throw new Error("AgentCard not supported for handler agents");
      }

      authenticate(_credentials: AuthenticationInfo): boolean {
        return true;
      }

      async startTask(params: TaskSendParams): Promise<Task> {
        let payload: Payload = null;
        const firstPart = params.message?.parts?.[0];
        if (firstPart) {
          if (firstPart.type === "text") {
            payload = firstPart.text;
          } else if (firstPart.type === "data") {
            payload = firstPart.data;
          }
        }

        const taskId = params.id ?? generateId();
        const response = await this.runTask(payload, taskId);

        return makeTask({
          id: taskId,
          state: TaskState.COMPLETED,
          payload: response ?? null,
          sessionId: params.sessionId ?? params.id ?? null,
        });
      }

      async runTask(payload: Payload, id: string | null): Promise<any> {
        return normalizedHandler(payload, id);
      }

      async getTaskStatus(_params: TaskQueryParams): Promise<Task> {
        throw new Error("Status queries not supported for handler agents");
      }

      async cancelTask(_params: TaskIdParams): Promise<Task> {
        throw new Error("Cancel not supported for handler agents");
      }

      async *subscribeToTaskUpdates(
        _params: TaskSendParams,
      ): AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
        throw new Error("Subscriptions not supported for handler agents");
      }

      async unsubscribeTask(_params: TaskIdParams): Promise<any> {
        throw new Error("Unsubscribe not supported for handler agents");
      }

      async registerPushEndpoint(
        _config: TaskPushNotificationConfig,
      ): Promise<TaskPushNotificationConfig> {
        throw new Error("Push notifications not supported for handler agents");
      }

      async getPushNotificationConfig(
        _params: TaskIdParams,
      ): Promise<TaskPushNotificationConfig> {
        throw new Error("Push notifications not supported for handler agents");
      }
    }

    return new HandlerAgent();
  }

  static async broadcast(
    this: typeof Agent,
    addresses: Array<FameAddress | string>,
    payload: Payload = null,
    options: AgentRunManyOptions = {},
  ): Promise<Array<[string, any | Error]>> {
    const targets: Array<readonly [FameAddress | string, Payload]> =
      addresses.map((address) => [address, payload] as const);
    return this.runMany(targets, options);
  }

  static async runMany<TAgent extends Agent>(
    this: typeof Agent,
    targets: Targets,
    options: AgentRunManyOptions = {},
  ): Promise<Array<[string, any | Error]>> {
    const { fabric, gatherExceptions = true } = options;
    const resolvedFabric = fabric ?? FameFabric.current();

    const proxies = new Map<string, AgentProxyContract<TAgent>>();
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
      if (result.status === "fulfilled") {
        return [addressKey, result.value] as const;
      }
      return [addressKey, result.reason] as const;
    });
  }


  async aserve(
    address: FameAddress | string,
    options: AgentServeOptions = {},
  ): Promise<void> {
    const { fabricOptions, logLevel = null } = options;

    if (logLevel !== null && logLevel !== undefined) {
      const resolvedLevel = normalizeLogLevel(logLevel);
      basicConfig({ level: resolvedLevel });
    }

    const stop = new Deferred<void>();
    const removeSignalHandlers = await setupSignalHandlers(stop);
    const { fabric, release } = await acquireFabric(fabricOptions);

    const serviceName =
      address instanceof FameAddress ? address.toString() : String(address);

    try {
      await fabric.serve(this, serviceName);
      logger.info("agent_live", {
        agent: this.constructor.name,
        address: serviceName,
      });

      await stop.promise;
      logger.info("agent_shutdown", {
        agent: this.constructor.name,
        address: serviceName,
      });
    } finally {
      removeSignalHandlers();
      await release();
    }
  }

  serve(
    address: FameAddress | string,
    options: AgentServeOptions = {},
  ): Promise<void> {
    return this.aserve(address, options);
  }
}
