import { FameAddress, FameFabric, generateId } from "naylence-runtime";
import type { FameEnvelope } from "naylence-core";
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
} from "./a2a-types.js";
import { TERMINAL_TASK_STATES } from "./task-states.js";
import { firstTextPart, makeTaskParams } from "./util.js";
import type { MakeTaskParamsOptions } from "./util.js";
import type {
  Agent,
  AgentProxyContract as AgentProxyInterface,
  Payload,
} from "./agent.js";

type RunTaskPayload = Payload;

type StreamParser<R> = (payload: Record<string, unknown>) => R;

type AgentTaskResult<TAgent extends Agent> = Awaited<
  ReturnType<TAgent["runTask"]>
>;

interface AgentProxyCtorOptions {
  address?: FameAddress | string | null;
  capabilities?: string[] | null;
  intentNl?: string | null;
  fabric: FameFabric;
}

interface StreamOptions {
  timeoutMs?: number | null;
  maxItems?: number | null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function toFameAddress(address: FameAddress | string): FameAddress {
  return address instanceof FameAddress
    ? address
    : new FameAddress(String(address));
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number | null | undefined,
): Promise<IteratorResult<T> | "timeout"> {
  if (timeoutMs == null) {
    return await iterator.next();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    return (await Promise.race([iterator.next(), timeoutPromise])) as
      | IteratorResult<T>
      | "timeout";
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class AgentProxy<TAgent extends Agent = Agent>
  implements AgentProxyInterface<TAgent>
{
  private readonly address: FameAddress | null;
  private readonly capabilities: string[] | null;
  private readonly intentNl: string | null;
  private readonly fabric: FameFabric;

  constructor(options: AgentProxyCtorOptions) {
    const {
      address = null,
      capabilities = null,
      intentNl = null,
      fabric,
    } = options;

    const provided =
      Number(address != null) +
      Number(capabilities != null) +
      Number(intentNl != null);
    if (provided !== 1) {
      throw new Error(
        "Provide exactly one of address | capabilities | intentNl",
      );
    }

    this.address = address ? toFameAddress(address) : null;
    this.capabilities = capabilities ? [...capabilities] : null;
    this.intentNl = intentNl;
    this.fabric = fabric;
  }

  get name(): string | null {
    return null;
  }

  get spec(): Record<string, unknown> {
    return {
      address: this.address ? this.address.toString() : null,
    };
  }

  get addressRef(): FameAddress | null {
    return this.address;
  }

  async getAgentCard(): Promise<AgentCard> {
    throw new Error("Fetching remote AgentCard not yet implemented");
  }

  authenticate(_credentials: AuthenticationInfo): boolean {
    void _credentials;
    throw new Error("Proxy authentication is not supported");
  }

  async runTask(
    payload: RunTaskPayload = null,
    id: string | null = null,
  ): Promise<AgentTaskResult<TAgent>> {
    const taskId = id ?? generateId();
    const params = makeTaskParams({ id: taskId, payload });
    const task = await this.startTask(params);

    let status: TaskStatus = task.status;

    if (!TERMINAL_TASK_STATES.has(status.state)) {
      const updates = await this.subscribeToTaskUpdates(
        makeTaskParams({ id: taskId, payload: null }),
      );
      const iterator = updates[Symbol.asyncIterator]();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            break;
          }

          const event = next.value;
          if (
            event &&
            typeof (event as TaskStatusUpdateEvent).status === "object"
          ) {
            const statusEvent = event as TaskStatusUpdateEvent;
            status = statusEvent.status;
            if (TERMINAL_TASK_STATES.has(status.state)) {
              break;
            }
          }
        }
      } finally {
        if (typeof iterator.return === "function") {
          await iterator.return();
        }
      }
    }

    if (status.state === TaskState.FAILED) {
      const message = status.message ?? null;
      const error = firstTextPart(message) ?? "Unknown error";
      throw new Error(error);
    }

    const message = status.message ?? null;
    if (
      !message ||
      !Array.isArray(message.parts) ||
      message.parts.length === 0
    ) {
      return null as AgentTaskResult<TAgent>;
    }

    const [first] = message.parts;
    if (!first) {
      return null as AgentTaskResult<TAgent>;
    }

    if (first.type === "text") {
      return ((first as TextPart).text ?? null) as AgentTaskResult<TAgent>;
    }

    if (first.type === "data") {
      return (first as DataPart).data as AgentTaskResult<TAgent>;
    }

    throw new Error(
      `Don't know how to extract payload from part: ${first.type}`,
    );
  }

  async startTask(params: TaskSendParams): Promise<Task>;
  async startTask(options: {
    id: string;
    role?: TaskSendParams["message"]["role"];
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
          role?: TaskSendParams["message"]["role"];
          payload: Payload;
          sessionId?: string | null;
          acceptedOutputModes?: string[] | null;
          pushNotification?: PushNotificationConfig | null;
          historyLength?: number | null;
          metadata?: Record<string, unknown> | null;
        },
  ): Promise<Task> {
    const params =
      "message" in paramsOrOptions
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

    const result = await this._invokeTarget("tasks/send", params);
    return TaskSchema.parse(result);
  }

  async getTaskStatus(params: TaskQueryParams): Promise<Task> {
    const payload = TaskQueryParamsSchema.parse(params);
    const result = await this._invokeTarget("tasks/get", payload);
    return TaskSchema.parse(result);
  }

  async cancelTask(params: TaskIdParams): Promise<Task> {
    const payload = TaskIdParamsSchema.parse(params);
    const result = await this._invokeTarget("tasks/cancel", payload);
    return TaskSchema.parse(result);
  }

  async subscribeToTaskUpdates(
    params: TaskSendParams,
    options: StreamOptions = {},
  ): Promise<AsyncIterable<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>> {
    const payload = TaskSendParamsSchema.parse(params);

    return this._streamRpc(
      "tasks/sendSubscribe",
      payload,
      (frame) => {
        if (Object.prototype.hasOwnProperty.call(frame, "artifact")) {
          return TaskArtifactUpdateEventSchema.parse(frame);
        }
        return TaskStatusUpdateEventSchema.parse(frame);
      },
      "tasks/sendUnsubscribe",
      TaskIdParamsSchema.parse({ id: payload.id }),
      options,
    );
  }

  async unsubscribeTask(params: TaskIdParams): Promise<unknown> {
    const payload = TaskIdParamsSchema.parse(params);
    return await this._invokeTarget("tasks/sendUnsubscribe", payload);
  }

  async registerPushEndpoint(
    config: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    const payload = TaskPushNotificationConfigSchema.parse(config);
    const result = await this._invokeTarget(
      "tasks/pushNotification/set",
      payload,
    );
    return TaskPushNotificationConfigSchema.parse(result ?? payload);
  }

  async getPushNotificationConfig(
    params: TaskIdParams,
  ): Promise<TaskPushNotificationConfig> {
    const payload = TaskIdParamsSchema.parse(params);
    const result = await this._invokeTarget(
      "tasks/pushNotification/get",
      payload,
    );
    return TaskPushNotificationConfigSchema.parse(result ?? payload);
  }

  private _streamRpc<R>(
    method: string,
    params: TaskSendParams,
    parseFrame: StreamParser<R>,
    unsubscribeMethod: string,
    unsubscribeParams: TaskIdParams,
    options: StreamOptions,
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
            typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
              "function"
          ) {
            throw new Error(
              "Expected streaming RPC to return an AsyncIterable",
            );
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
            if (iterator && typeof iterator.return === "function") {
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
            const result = await nextWithTimeout(
              source,
              options.timeoutMs ?? null,
            );
            if (result === "timeout") {
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

  private async _invokeTarget(
    method: string,
    params: Record<string, unknown> | TaskSendParams,
    options: { streaming?: boolean } = {},
  ): Promise<any> {
    const payload = toRecord(params);

    if (this.address) {
      if (options.streaming) {
        return await this.fabric.invokeStream(this.address, method, payload);
      }
      return await this.fabric.invoke(this.address, method, payload);
    }

    if (this.capabilities) {
      if (options.streaming) {
        return await this.fabric.invokeByCapabilityStream(
          this.capabilities,
          method,
          payload,
        );
      }
      return await this.fabric.invokeByCapability(
        this.capabilities,
        method,
        payload,
      );
    }

    if (this.intentNl) {
      throw new Error("Intent-based routing not yet supported");
    }

    throw new Error("Proxy has no routing target");
  }

  static remoteByAddress<TAgent extends Agent>(
    address: FameAddress,
    options: { fabric: FameFabric },
  ): AgentProxy<TAgent> {
    return new AgentProxy<TAgent>({ address, fabric: options.fabric });
  }

  static remoteByCapabilities<TAgent extends Agent>(
    capabilities: string[],
    options: { fabric: FameFabric },
  ): AgentProxy<TAgent> {
    return new AgentProxy<TAgent>({ capabilities, fabric: options.fabric });
  }
}
export type { FameEnvelope };
