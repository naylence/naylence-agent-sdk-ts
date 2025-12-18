/**
 * Agent base for running background work (polling/cron-like).
 *
 * {@link BackgroundTaskAgent} extends {@link BaseAgent} with infrastructure for
 * long-running, asynchronous task execution. Tasks run in the background after
 * being started, with status updates streamed to subscribers.
 *
 * @remarks
 * Use BackgroundTaskAgent when:
 * - Task execution takes significant time (seconds to minutes)
 * - You need to report progress updates during execution
 * - Clients should not block waiting for completion
 *
 * For simple request-response patterns, use {@link BaseAgent} instead.
 *
 * @module
 */
import { AsyncLock, getLogger } from '@naylence/runtime';

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
} from './a2a-types.js';
import {
  BaseAgent,
  type BaseAgentOptions,
  type BaseAgentState,
  TERMINAL_TASK_STATES,
} from './base-agent.js';
import { makeMessage } from './util.js';

const logger = getLogger('naylence.agent.background_task_agent');

/** @internal */
const DEFAULT_EVENT_QUEUE_SIZE = 1000;

/** @internal */
const END_OF_STREAM_SENTINEL: TaskStatusUpdateEvent = Object.freeze({
  id: '__sentinel__',
  status: {
    state: TaskState.UNKNOWN,
    message: null,
    timestamp: new Date(),
  },
  final: false,
  metadata: null,
});

/** @internal */
const TIMEOUT_SYMBOL = Symbol('background-task-queue-timeout');

/** @internal */
type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/** @internal */
type CompletedEntry = {
  status: TaskStatus;
  timestamp: number;
};

/** @internal */
function monotonicSeconds(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

/** @internal */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timeout = globalThis.setTimeout;
    if (typeof timeout !== 'function') {
      throw new Error('setTimeout is not available in the current environment');
    }
    timeout(resolve, ms);
  });
}

/** @internal */
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

/** @internal */
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

/** @internal */
function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.toString();
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch (_serializationError) {
    return String(error);
  }
}

/**
 * Configuration options for {@link BackgroundTaskAgent}.
 */
export interface BackgroundTaskAgentOptions<StateT extends BaseAgentState>
  extends BaseAgentOptions<StateT> {
  /** Maximum number of events buffered per task. Defaults to 1000. */
  maxQueueSize?: number;
  /**
   * Maximum task execution time in milliseconds.
   * Tasks exceeding this limit are automatically canceled. Null disables the limit.
   */
  maxTaskLifetimeMs?: number | null;
  /** Maximum number of completed tasks to cache. Defaults to 100. */
  completedCacheSize?: number;
  /** Time-to-live for cached completed tasks in seconds. Defaults to 300. */
  completedCacheTtlSec?: number;
}

/**
 * Base class for agents that execute long-running background tasks.
 *
 * Unlike {@link BaseAgent} which runs tasks synchronously in startTask,
 * BackgroundTaskAgent starts tasks in the background and streams status
 * updates to subscribers. This is ideal for work that takes significant time.
 *
 * @remarks
 * Lifecycle:
 * 1. Client calls startTask, which returns immediately with WORKING status
 * 2. runBackgroundTask executes asynchronously
 * 3. Status updates are queued and delivered to subscribers
 * 4. Task completes with COMPLETED, FAILED, or CANCELED status
 *
 * Completed tasks are cached briefly for late subscribers to retrieve final status.
 *
 * @example
 * ```typescript
 * import {
 *   BackgroundTaskAgent,
 *   TaskSendParams,
 *   TaskState,
 * } from '@naylence/agent-sdk';
 *
 * class SlowAgent extends BackgroundTaskAgent {
 *   protected async runBackgroundTask(params: TaskSendParams): Promise<string> {
 *     // Report progress
 *     await this.updateTaskState(params.id, TaskState.WORKING);
 *
 *     // Do expensive work
 *     await someSlowOperation();
 *
 *     // Return value becomes the task result
 *     return 'done';
 *   }
 * }
 *
 * const agent = new SlowAgent('slow-worker', {
 *   maxTaskLifetimeMs: 60_000, // 1 minute timeout
 * });
 * await agent.serve('fame://slow-worker');
 * ```
 *
 * @typeParam StateT - The state model type, defaults to {@link BaseAgentState}.
 */
export abstract class BackgroundTaskAgent<
  StateT extends BaseAgentState = BaseAgentState,
> extends BaseAgent<StateT> {
  /** @internal */
  private readonly maxQueueSize: number;
  /** @internal */
  private readonly maxTaskLifetimeMs: number | null;
  /** @internal */
  private readonly taskStatuses = new Map<string, TaskStatus>();
  /** @internal */
  private readonly taskEventQueues = new Map<string, AsyncEventQueue<TaskEvent>>();
  /** @internal */
  private readonly completed = new Map<string, CompletedEntry>();
  /** @internal */
  private readonly completedCacheSize: number;
  /** @internal */
  private readonly completedCacheTtlSec: number;
  /** @internal */
  private readonly statusLock = new AsyncLock();

  /**
   * Creates a new BackgroundTaskAgent.
   *
   * @param name - Agent name. Defaults to snake_case of the class name.
   * @param options - Configuration options for task execution and caching.
   */
  protected constructor(
    name: string | null = null,
    options: BackgroundTaskAgentOptions<StateT> = {}
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

  /** @internal */
  private isTerminalTaskState(taskId: string): boolean {
    const status = this.taskStatuses.get(taskId);
    if (status && TERMINAL_TASK_STATES.has(status.state)) {
      return true;
    }
    return this.completed.has(taskId);
  }

  /**
   * Starts a background task.
   *
   * Returns immediately with WORKING status. The task executes asynchronously
   * via {@link BackgroundTaskAgent.runBackgroundTask}.
   *
   * @param params - Task parameters.
   * @returns The task with initial WORKING status.
   */
  async startTask(params: TaskSendParams): Promise<Task> {
    this.taskEventQueues.set(
      params.id,
      new AsyncEventQueue<TaskEvent | TaskStatusUpdateEvent>(this.maxQueueSize)
    );

    await this.updateTaskState(params.id, TaskState.WORKING);

    void this.runBackgroundTaskInternal(params);

    if (this.maxTaskLifetimeMs !== null) {
      void this.enforceMaxLifetime(params.id);
    }

    return await this.getTaskStatus({ id: params.id });
  }

  /** @internal */
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

  /** @internal */
  private async runBackgroundTaskInternal(params: TaskSendParams): Promise<void> {
    try {
      const result = await this.runBackgroundTask(params);
      const messagePayload = this.normalizeResultPayload(result);
      const message = makeMessage(messagePayload);
      await this.updateTaskState(params.id, TaskState.COMPLETED, message ?? undefined);
    } catch (error) {
      const errorMessage = makeMessage(errorToString(error));
      await this.updateTaskState(params.id, TaskState.FAILED, errorMessage ?? undefined);
      logger.error('background_task_failed', {
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

  /**
   * Override to implement background task execution logic.
   *
   * This method runs asynchronously after startTask returns. The return value
   * becomes the task's completion message. Throwing an error fails the task.
   *
   * @remarks
   * Call {@link BackgroundTaskAgent.updateTaskState} to report progress.
   * Call {@link BackgroundTaskAgent.updateTaskArtifact} to emit artifacts.
   *
   * @param params - The original task parameters.
   * @returns The task result, which is included in the completion message.
   *
   * @example
   * ```typescript
   * protected async runBackgroundTask(params: TaskSendParams): Promise<unknown> {
   *   for (let i = 0; i < 10; i++) {
   *     await this.updateTaskState(params.id, TaskState.WORKING);
   *     await doStep(i);
   *   }
   *   return { steps: 10 };
   * }
   * ```
   */
  protected abstract runBackgroundTask(params: TaskSendParams): Promise<unknown>;

  /**
   * Gets the current state of a task.
   *
   * @param taskId - The task identifier.
   * @returns The current task state, or UNKNOWN if not found.
   */
  async getTaskState(taskId: string): Promise<TaskState> {
    try {
      const task = await this.getTaskStatus({ id: taskId });
      return task.status.state;
    } catch (_error) {
      return TaskState.UNKNOWN;
    }
  }

  /**
   * Retrieves the full status of a task.
   *
   * @param params - Query parameters including the task ID.
   * @returns The task with current status.
   * @throws Error if the task is unknown or expired.
   */
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

  /**
   * Updates the state of a running task.
   *
   * Call this from {@link BackgroundTaskAgent.runBackgroundTask} to report progress.
   * Status updates are delivered to subscribers.
   *
   * @param taskId - The task identifier.
   * @param state - The new task state.
   * @param message - Optional message with details.
   * @returns True if the update was applied, false if the task is already terminal.
   */
  async updateTaskState(
    taskId: string,
    state: TaskState,
    message?: Message | null
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
        logger.warning('task_state_update_missing_queue', { taskId });
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

  /** @internal */
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

  /**
   * Emits an artifact for a running task.
   *
   * Artifacts are delivered to subscribers as TaskArtifactUpdateEvents.
   *
   * @param taskId - The task identifier.
   * @param artifact - The artifact to emit.
   */
  async updateTaskArtifact(taskId: string, artifact: Artifact): Promise<void> {
    const queue = this.taskEventQueues.get(taskId);
    if (!queue) {
      logger.warning('task_artifact_update_missing_queue', { taskId });
      return;
    }

    const event: TaskArtifactUpdateEvent = {
      id: taskId,
      artifact,
      metadata: null,
    };

    await queue.put(event);
  }

  /**
   * Subscribes to updates for a task.
   *
   * Returns an async iterable that yields status and artifact events.
   * For completed tasks, yields the cached final status if still available.
   *
   * @param params - Task parameters including the task ID.
   * @returns Async iterable of task events.
   */
  subscribeToTaskUpdates(params: TaskSendParams): AsyncIterable<TaskEvent> {
    const queue = this.taskEventQueues.get(params.id);
    const self = this;

    const stream = async function* (): AsyncIterable<TaskEvent> {
      if (!queue) {
        const entry = self.completed.get(params.id);
        if (entry && monotonicSeconds() - entry.timestamp <= self.completedCacheTtlSec) {
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

        if ('status' in event && TERMINAL_TASK_STATES.has(event.status.state)) {
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

  /**
   * Cancels a task subscription.
   *
   * @param params - Parameters including the task ID.
   */
  async unsubscribeTask(params: TaskIdParams): Promise<void> {
    const queue = this.taskEventQueues.get(params.id);
    if (queue) {
      this.taskEventQueues.delete(params.id);
      await queue.put(END_OF_STREAM_SENTINEL);
    }
  }

  /**
   * Cancels a running task.
   *
   * Sets the task state to CANCELED. Does not interrupt runBackgroundTask,
   * but prevents further state updates.
   *
   * @param params - Parameters including the task ID.
   * @returns The task with CANCELED status.
   */
  async cancelTask(params: TaskIdParams): Promise<Task> {
    await this.updateTaskState(params.id, TaskState.CANCELED);
    return await this.getTaskStatus({ id: params.id });
  }

  /** @internal */
  private async purgeCompletedAfterTtl(taskId: string): Promise<void> {
    await delay(this.completedCacheTtlSec * 1000);
    this.completed.delete(taskId);
    this.taskEventQueues.delete(taskId);
  }

  /** @internal */
  private normalizeResultPayload(result: unknown): string | Record<string, unknown> | null {
    if (result === null || result === undefined) {
      return null;
    }
    if (typeof result === 'string') {
      return result;
    }
    if (typeof result === 'object') {
      return result as Record<string, unknown>;
    }
    return String(result);
  }
}
