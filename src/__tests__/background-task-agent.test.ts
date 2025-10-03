import { jest } from "@jest/globals";

import {
  type BackgroundTaskAgentOptions,
  BackgroundTaskAgent,
} from "../naylence/agent/background-task-agent.js";
import {
  type Artifact,
  type Message,
  TaskSendParams,
  TaskState,
  type TaskStatusUpdateEvent,
} from "../naylence/agent/a2a-types.js";
import { BaseAgentState } from "../naylence/agent/base-agent.js";

function createMessage(text: string): Message {
  return {
    role: "user",
    parts: [
      {
        type: "text",
        text,
        metadata: null,
      },
    ],
    metadata: null,
  };
}

function createSendParams(taskId: string, text: string): TaskSendParams {
  return {
    id: taskId,
    sessionId: `${taskId}-session`,
    message: createMessage(text),
    acceptedOutputModes: null,
    pushNotification: null,
    historyLength: null,
    metadata: null,
  };
}

function createArtifact(name: string): Artifact {
  return {
    name,
    description: null,
    parts: [
      {
        type: "text",
        text: `${name}-payload`,
        metadata: null,
      },
    ],
    metadata: null,
    index: 0,
    append: null,
    lastChunk: null,
  };
}

class ControllableBackgroundAgent extends BackgroundTaskAgent {
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();

  constructor(options: BackgroundTaskAgentOptions<BaseAgentState> = {}) {
    super("controllable-agent", options);
  }

  protected override async runBackgroundTask(
    params: TaskSendParams,
  ): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(params.id, { resolve, reject });
    });
  }

  resolveTask(id: string, value: unknown): void {
    const entry = this.pending.get(id);
    if (entry) {
      entry.resolve(value);
      this.pending.delete(id);
    }
  }

  rejectTask(id: string, error: unknown): void {
    const entry = this.pending.get(id);
    if (entry) {
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

describe("BackgroundTaskAgent", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test("streams working, artifact, and completed events", async () => {
    const agent = new ControllableBackgroundAgent();
    const params = createSendParams("task-1", "start");

    const task = await agent.startTask(params);
    expect(task.status.state).toBe(TaskState.WORKING);

    const stream = await agent.subscribeToTaskUpdates(params);
    const iterator = stream[Symbol.asyncIterator]();

    const firstEvent = (await iterator.next()).value as TaskStatusUpdateEvent;
    expect(firstEvent.status.state).toBe(TaskState.WORKING);

    await agent.updateTaskArtifact(params.id, createArtifact("artifact-1"));
    const artifactEvent = await iterator.next();
    expect(artifactEvent.value).toBeDefined();
    if (!artifactEvent.value || !("artifact" in artifactEvent.value)) {
      throw new Error("Expected artifact event");
    }
    expect(artifactEvent.value.artifact?.name).toBe("artifact-1");

    agent.resolveTask(params.id, { result: true });
    const finalEvent = (await iterator.next()).value as TaskStatusUpdateEvent;
    expect(finalEvent.status.state).toBe(TaskState.COMPLETED);
    expect(finalEvent.final).toBe(true);

    const completion = await iterator.next();
    expect(completion.done).toBe(true);

    const status = await agent.getTaskStatus({ id: params.id });
    expect(status.status.state).toBe(TaskState.COMPLETED);

    await agent.unsubscribeTask({ id: params.id, metadata: null });
    const lateStream = await agent.subscribeToTaskUpdates(params);
    const lateIterator = lateStream[Symbol.asyncIterator]();
    const lateEvent = (await lateIterator.next())
      .value as TaskStatusUpdateEvent;
    expect(lateEvent.status.state).toBe(TaskState.COMPLETED);
    const lateDone = await lateIterator.next();
    expect(lateDone.done).toBe(true);
  });

  test("records failures and includes error message", async () => {
    const agent = new ControllableBackgroundAgent();
    const params = createSendParams("task-2", "start");

    await agent.startTask(params);
    const stream = await agent.subscribeToTaskUpdates(params);
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next(); // working

    agent.rejectTask(params.id, new Error("boom"));
    const failureEvent = (await iterator.next()).value as TaskStatusUpdateEvent;
    expect(failureEvent.status.state).toBe(TaskState.FAILED);
    expect(failureEvent.status.message).not.toBeNull();

    expect((await iterator.next()).done).toBe(true);

    const status = await agent.getTaskStatus({ id: params.id });
    expect(status.status.state).toBe(TaskState.FAILED);

    const secondUpdate = await agent.updateTaskState(
      params.id,
      TaskState.WORKING,
    );
    expect(secondUpdate).toBe(false);
  });

  test("cancels stalled tasks after max lifetime", async () => {
    const agent = new ControllableBackgroundAgent({ maxTaskLifetimeMs: 500 });
    const params = createSendParams("task-3", "start");

    await agent.startTask(params);
    const stream = await agent.subscribeToTaskUpdates(params);
    const iterator = stream[Symbol.asyncIterator]();

    await iterator.next(); // working
    const nextEventPromise = iterator.next();

    await jest.advanceTimersByTimeAsync(500);
    const canceledEvent = (await nextEventPromise)
      .value as TaskStatusUpdateEvent;
    expect(canceledEvent.status.state).toBe(TaskState.CANCELED);

    agent.resolveTask(params.id, "ignored");
    await jest.advanceTimersByTimeAsync(1000);

    expect((await iterator.next()).done).toBe(true);
    const canceledTask = await agent.cancelTask({
      id: params.id,
      metadata: null,
    });
    expect(canceledTask.status.state).toBe(TaskState.CANCELED);
  });

  test("completed tasks remain in cache until TTL expires", async () => {
    const agent = new ControllableBackgroundAgent({
      completedCacheTtlSec: 0.1,
    });
    const params = createSendParams("task-4", "start");

    await agent.startTask(params);
    const stream = await agent.subscribeToTaskUpdates(params);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next(); // working

    agent.resolveTask(params.id, "done");
    const completionEvent = (await iterator.next())
      .value as TaskStatusUpdateEvent;
    expect(completionEvent.status.state).toBe(TaskState.COMPLETED);
    const completionDone = await iterator.next();
    expect(completionDone.done).toBe(true);

    const cached = await agent.getTaskStatus({ id: params.id });
    expect(cached.status.state).toBe(TaskState.COMPLETED);

    await jest.advanceTimersByTimeAsync(200); // TTL elapsed

    await expect(agent.getTaskStatus({ id: params.id })).rejects.toThrow(
      /Unknown or expired task/,
    );
  });
});
