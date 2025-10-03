import { AsyncLock, getLogger } from "naylence-runtime";

import {
  type Artifact,
  type Message,
  Task,
  type TaskArtifactUpdateEvent,
  TaskIdParams,
  type TaskQueryParams,
  TaskSendParams,
  TaskState,
  type TaskStatus,
  type TaskStatusUpdateEvent,
} from "./a2a-types.js";
import {
  BaseAgent,
  type BaseAgentOptions,
  type BaseAgentState,
  TERMINAL_TASK_STATES,
} from "./base-agent.js";
import { makeMessage } from "./util.js";

const logger = getLogger("naylence.agent.background-task-agent");

const DEFAULT_EVENT_QUEUE_SIZE = 1000;
const END_OF_STREAM_SENTINEL: TaskStatusUpdateEvent = Object.freeze({
  id: "__sentinel__",
  status: {
    state: TaskState.UNKNOWN,
    message: null,
    timestamp: new Date(),
  },
  final: false,
  metadata: null,
});

const TIMEOUT_SYMBOL = Symbol("background-task-queue-timeout");

type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

type CompletedEntry = {
  status: TaskStatus;
  timestamp: number;
};

function monotonicSeconds(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = globalThis.setTimeout;
    if (typeof timeout !== "function") {
      throw new Error("setTimeout is not available in the current environment");
    }
    timeout(resolve, ms);
  });
}

class AsyncEventQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waitingGets: Array<(value: T) => void> = [];
  private readonly waitingPuts: Array<() => void> = [];

  constructor(private readonly maxSize: number) {}

  async put(value: T): Promise<void> {
    if (this.waitingGets.length > 0) {
      const resolveGet = this.waitingGets.shift();
      if (resolveGet) {
        resolveGet(value);
      }
      return;
    }

    while (this.buffer.length >= this.maxSize) {
      await new Promise<void>((resolve) => {
        this.waitingPuts.push(resolve);
      });
    }

    this.buffer.push(value);
  }

  async get(): Promise<T> {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift()!;
      this.resolveNextPut();
      return value;
    }

    return await new Promise<T>((resolve) => {
      this.waitingGets.push((value) => {
        resolve(value);
        this.resolveNextPut();
      });
    });
  }

  private resolveNextPut(): void {
    if (this.waitingPuts.length > 0) {
      const resolvePut = this.waitingPuts.shift();
      resolvePut?.();
    }
  }
}

function createTaskFromStatus(id: string, status: TaskStatus): Task {
  return {
    id,
    sessionId: null,
    status,
    artifacts: null,
    history: null,
    metadata: null,
  };
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.toString();
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_serializationError) {
    return String(error);
  }
}

export interface BackgroundTaskAgentOptions<StateT extends BaseAgentState>
  extends BaseAgentOptions<StateT> {
  maxQueueSize?: number;
  maxTaskLifetimeMs?: number | null;
  completedCacheSize?: number;
  completedCacheTtlSec?: number;
}

export abstract class BackgroundTaskAgent<
  StateT extends BaseAgentState = BaseAgentState,
> extends BaseAgent<StateT> {
  private readonly maxQueueSize: number;
  private readonly maxTaskLifetimeMs: number | null;
  private readonly taskStatuses = new Map<string, TaskStatus>();
  private readonly taskEventQueues = new Map<
    string,
    AsyncEventQueue<TaskEvent>
  >();
  private readonly completed = new Map<string, CompletedEntry>();
  private readonly completedCacheSize: number;
  private readonly completedCacheTtlSec: number;
  private readonly statusLock = new AsyncLock();

  protected constructor(
    name: string | null = null,
    options: BackgroundTaskAgentOptions<StateT> = {},
  ) {
    const {
      maxQueueSize = DEFAULT_EVENT_QUEUE_SIZE,
      maxTaskLifetimeMs = null,
      completedCacheSize = 100,
      completedCacheTtlSec = 300,
      ...baseOptions
    } = options;

    super(name, baseOptions);

    this.maxQueueSize = maxQueueSize;
    this.maxTaskLifetimeMs = maxTaskLifetimeMs;
    this.completedCacheSize = completedCacheSize;
    this.completedCacheTtlSec = completedCacheTtlSec;
  }

  private isTerminalTaskState(taskId: string): boolean {
    const status = this.taskStatuses.get(taskId);
    if (status && TERMINAL_TASK_STATES.has(status.state)) {
      return true;
    }
    return this.completed.has(taskId);
  }

  async startTask(params: TaskSendParams): Promise<Task> {
    this.taskEventQueues.set(
      params.id,
      new AsyncEventQueue<TaskEvent | TaskStatusUpdateEvent>(this.maxQueueSize),
    );

    await this.updateTaskState(params.id, TaskState.WORKING);

    void this.runBackgroundTaskInternal(params);

    if (this.maxTaskLifetimeMs !== null) {
      void this.enforceMaxLifetime(params.id);
    }

    return await this.getTaskStatus({ id: params.id });
  }

  private async enforceMaxLifetime(taskId: string): Promise<void> {
    if (this.maxTaskLifetimeMs === null) {
      return;
    }

    await delay(this.maxTaskLifetimeMs);

    if (!this.isTerminalTaskState(taskId)) {
      await this.updateTaskState(taskId, TaskState.CANCELED);
    }

    const queue = this.taskEventQueues.get(taskId);
    if (queue) {
      await queue.put(END_OF_STREAM_SENTINEL);
    }
  }

  private async runBackgroundTaskInternal(
    params: TaskSendParams,
  ): Promise<void> {
    try {
      const result = await this.runBackgroundTask(params);
      const messagePayload = this.normalizeResultPayload(result);
      const message = makeMessage(messagePayload);
      await this.updateTaskState(
        params.id,
        TaskState.COMPLETED,
        message ?? undefined,
      );
    } catch (error) {
      const errorMessage = makeMessage(errorToString(error));
      await this.updateTaskState(
        params.id,
        TaskState.FAILED,
        errorMessage ?? undefined,
      );
      logger.error("background_task_failed", {
        taskId: params.id,
        error,
      });
    } finally {
      const queue = this.taskEventQueues.get(params.id);
      if (queue) {
        await queue.put(END_OF_STREAM_SENTINEL);
      }
    }
  }

  protected abstract runBackgroundTask(
    params: TaskSendParams,
  ): Promise<unknown>;

  async getTaskState(taskId: string): Promise<TaskState> {
    try {
      const task = await this.getTaskStatus({ id: taskId });
      return task.status.state;
    } catch (_error) {
      return TaskState.UNKNOWN;
    }
  }

  async getTaskStatus(params: TaskQueryParams): Promise<Task> {
    return await this.statusLock.runExclusive(async () => {
      const status = this.taskStatuses.get(params.id);
      if (status) {
        return createTaskFromStatus(params.id, status);
      }

      const entry = this.completed.get(params.id);
      if (entry) {
        if (monotonicSeconds() - entry.timestamp <= this.completedCacheTtlSec) {
          return createTaskFromStatus(params.id, entry.status);
        }
        this.completed.delete(params.id);
      }

      throw new Error(`Unknown or expired task ${params.id}`);
    });
  }

  async updateTaskState(
    taskId: string,
    state: TaskState,
    message?: Message | null,
  ): Promise<boolean> {
    return await this.statusLock.runExclusive(async () => {
      if (this.isTerminalTaskState(taskId)) {
        return false;
      }

      const status: TaskStatus = {
        state,
        message: message ?? null,
        timestamp: new Date(),
      };

      this.taskStatuses.set(taskId, status);

      const queue = this.taskEventQueues.get(taskId);
      if (!queue) {
        logger.warning("task_state_update_missing_queue", { taskId });
        return false;
      }

      const event: TaskStatusUpdateEvent = {
        id: taskId,
        status,
        final: TERMINAL_TASK_STATES.has(state),
        metadata: null,
      };

      await queue.put(event);

      if (TERMINAL_TASK_STATES.has(state)) {
        this.taskStatuses.delete(taskId);
        this.addToCompleted(taskId, status);
        void this.purgeCompletedAfterTtl(taskId);
      }

      return true;
    });
  }

  private addToCompleted(taskId: string, status: TaskStatus): void {
    if (this.completedCacheSize <= 0) {
      return;
    }

    if (this.completed.has(taskId)) {
      this.completed.delete(taskId);
    }

    while (this.completed.size >= this.completedCacheSize) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.completed.delete(oldest);
    }

    this.completed.set(taskId, {
      status,
      timestamp: monotonicSeconds(),
    });
  }

  async updateTaskArtifact(taskId: string, artifact: Artifact): Promise<void> {
    const queue = this.taskEventQueues.get(taskId);
    if (!queue) {
      logger.warning("task_artifact_update_missing_queue", { taskId });
      return;
    }

    const event: TaskArtifactUpdateEvent = {
      id: taskId,
      artifact,
      metadata: null,
    };

    await queue.put(event);
  }

  subscribeToTaskUpdates(params: TaskSendParams): AsyncIterable<TaskEvent> {
    const queue = this.taskEventQueues.get(params.id);
    const self = this;

    const stream = async function* (): AsyncIterable<TaskEvent> {
      if (!queue) {
        const entry = self.completed.get(params.id);
        if (
          entry &&
          monotonicSeconds() - entry.timestamp <= self.completedCacheTtlSec
        ) {
          yield {
            id: params.id,
            status: entry.status,
            final: TERMINAL_TASK_STATES.has(entry.status.state),
            metadata: null,
          } satisfies TaskStatusUpdateEvent;
        }
        return;
      }

      let seenTerminal = false;
      while (true) {
        const nextEventPromise = queue.get();
        const timeoutPromise =
          self.maxTaskLifetimeMs === null
            ? null
            : delay(self.maxTaskLifetimeMs).then(() => TIMEOUT_SYMBOL);

        const result = timeoutPromise
          ? await Promise.race([nextEventPromise, timeoutPromise])
          : await nextEventPromise;

        if (result === TIMEOUT_SYMBOL) {
          break;
        }

        const event = result as TaskEvent;
        if (event === END_OF_STREAM_SENTINEL) {
          break;
        }

        if ("status" in event && TERMINAL_TASK_STATES.has(event.status.state)) {
          if (seenTerminal) {
            continue;
          }
          seenTerminal = true;
        }

        yield event;
      }
    };

    return stream();
  }

  async unsubscribeTask(params: TaskIdParams): Promise<void> {
    const queue = this.taskEventQueues.get(params.id);
    if (queue) {
      this.taskEventQueues.delete(params.id);
      await queue.put(END_OF_STREAM_SENTINEL);
    }
  }

  async cancelTask(params: TaskIdParams): Promise<Task> {
    await this.updateTaskState(params.id, TaskState.CANCELED);
    return await this.getTaskStatus({ id: params.id });
  }

  private async purgeCompletedAfterTtl(taskId: string): Promise<void> {
    await delay(this.completedCacheTtlSec * 1000);
    this.completed.delete(taskId);
    this.taskEventQueues.delete(taskId);
  }

  private normalizeResultPayload(
    result: unknown,
  ): string | Record<string, unknown> | null {
    if (result === null || result === undefined) {
      return null;
    }
    if (typeof result === "string") {
      return result;
    }
    if (typeof result === "object") {
      return result as Record<string, unknown>;
    }
    return String(result);
  }
}
