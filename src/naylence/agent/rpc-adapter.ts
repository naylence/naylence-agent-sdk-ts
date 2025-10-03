import {
  JSONRPCError,
  JSONRPCRequest,
  JSONRPCRequestSchema,
  JSONRPCResponse,
} from "naylence-core";
import {
  A2ARequestSchema,
  InternalError,
  InvalidParamsError,
  InvalidRequestError,
  MethodNotFoundError,
  PushNotificationNotSupportedError,
  TaskNotCancelableError,
  UnsupportedOperationError,
  serializeTask,
  serializeTaskStatus,
  TaskArtifactUpdateEvent,
  TaskArtifactUpdateEventSchema,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskSendParams,
  TaskStatusUpdateEvent,
  TaskStatusUpdateEventSchema,
} from "./a2a-types.js";
import { Agent } from "./agent.js";
import {
  AgentException,
  AuthorizationException,
  ConflictException,
  DuplicateTaskException,
  InvalidDataException,
  InvalidTaskException,
  NoDataFoundException,
  PushNotificationNotSupportedException,
  RateLimitExceededException,
  TaskNotCancelableException,
  UnsupportedOperationException,
} from "./errors.js";
import { extractId } from "./util.js";

const JSONRPC_VERSION = "2.0";

const A2A_METHODS = new Set([
  "tasks/send",
  "tasks/sendSubscribe",
  "tasks/sendUnsubscribe",
  "tasks/get",
  "tasks/cancel",
  "tasks/pushNotification/set",
  "tasks/pushNotification/get",
  "tasks/resubscribe",
  "agent.get_card",
]);

function toJSONRPCError(error: unknown): JSONRPCError {
  if (error && typeof error === "object") {
    const maybeError = error as Record<string, unknown>;
    if (typeof maybeError.toJSON === "function") {
      return maybeError.toJSON();
    }
    if (
      typeof maybeError.code === "number" &&
      typeof maybeError.message === "string"
    ) {
      return {
        code: maybeError.code,
        message: maybeError.message,
        data: maybeError.data,
      } satisfies JSONRPCError;
    }
  }

  if (error instanceof Error) {
    return {
      code: -32603,
      message: error.message,
    } satisfies JSONRPCError;
  }

  return {
    code: -32603,
    message: String(error),
  } satisfies JSONRPCError;
}

function createErrorResponse(
  id: JSONRPCResponse["id"],
  error: unknown,
): JSONRPCResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: toJSONRPCError(error),
  };
}

function createResultResponse(
  id: JSONRPCResponse["id"],
  result: unknown,
): JSONRPCResponse {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    result,
  };
}

function normalizeRpcParams(params: unknown): {
  args: unknown[];
  kwargs: Record<string, unknown>;
} {
  if (!params || typeof params !== "object") {
    return { args: [], kwargs: {} };
  }

  const candidate = params as Record<string, unknown>;
  const argsCandidate = candidate.args;
  const kwargsCandidate = candidate.kwargs;

  const args = Array.isArray(argsCandidate) ? [...argsCandidate] : [];
  const kwargs =
    kwargsCandidate && typeof kwargsCandidate === "object"
      ? { ...(kwargsCandidate as Record<string, unknown>) }
      : {};

  if (args.length === 0 && Object.keys(kwargs).length === 0) {
    return { args: [], kwargs: { ...candidate } };
  }

  return { args, kwargs };
}

async function* handleA2ARpcRequest(
  agent: Agent,
  a2aRequest: JSONRPCRequest,
): AsyncGenerator<JSONRPCResponse> {
  const id = a2aRequest.id ?? null;

  let parsed;
  try {
    parsed = A2ARequestSchema.parse(a2aRequest);
  } catch (error) {
    yield createErrorResponse(
      id,
      new InvalidRequestError(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return;
  }

  try {
    switch (parsed.method) {
      case "tasks/send": {
        const result = await agent.startTask(parsed.params as TaskSendParams);
        yield createResultResponse(id, serializeTask(result));
        break;
      }
      case "tasks/get": {
        const result = await agent.getTaskStatus(
          parsed.params as TaskQueryParams,
        );
        yield createResultResponse(id, result ? serializeTask(result) : null);
        break;
      }
      case "tasks/cancel": {
        const result = await agent.cancelTask(parsed.params as TaskIdParams);
        yield createResultResponse(id, result ? serializeTask(result) : null);
        break;
      }
      case "tasks/pushNotification/set": {
        const result = await agent.registerPushEndpoint(
          parsed.params as TaskPushNotificationConfig,
        );
        yield createResultResponse(id, result ?? null);
        break;
      }
      case "tasks/pushNotification/get": {
        const result = await agent.getPushNotificationConfig(
          parsed.params as TaskIdParams,
        );
        yield createResultResponse(id, result ?? null);
        break;
      }
      case "agent.get_card": {
        const result = await agent.getAgentCard();
        yield createResultResponse(id, result);
        break;
      }
      case "tasks/sendSubscribe": {
        const stream = await agent.subscribeToTaskUpdates(
          parsed.params as TaskSendParams,
        );
        for await (const event of stream as AsyncIterable<
          TaskStatusUpdateEvent | TaskArtifactUpdateEvent
        >) {
          if (TaskStatusUpdateEventSchema.safeParse(event).success) {
            const payload = TaskStatusUpdateEventSchema.parse(event);
            yield createResultResponse(id, {
              ...payload,
              status: serializeTaskStatus(payload.status),
            });
          } else {
            yield createResultResponse(
              id,
              TaskArtifactUpdateEventSchema.parse(event),
            );
          }
        }
        yield createResultResponse(id, null);
        break;
      }
      case "tasks/sendUnsubscribe": {
        await agent.unsubscribeTask(parsed.params as TaskIdParams);
        yield createResultResponse(id, null);
        break;
      }
      default: {
        yield createErrorResponse(id, new MethodNotFoundError());
      }
    }
  } catch (error) {
    if (error instanceof InvalidTaskException) {
      yield createErrorResponse(id, new InvalidParamsError(error.message));
    } else if (
      error instanceof DuplicateTaskException ||
      error instanceof ConflictException
    ) {
      yield createErrorResponse(id, new InvalidParamsError(error.message));
    } else if (error instanceof NoDataFoundException) {
      yield createErrorResponse(id, new InvalidParamsError(error.message));
    } else if (error instanceof InvalidDataException) {
      yield createErrorResponse(id, new InvalidParamsError(error.message));
    } else if (error instanceof TaskNotCancelableException) {
      yield createErrorResponse(id, new TaskNotCancelableError());
    } else if (error instanceof PushNotificationNotSupportedException) {
      yield createErrorResponse(id, new PushNotificationNotSupportedError());
    } else if (error instanceof UnsupportedOperationException) {
      yield createErrorResponse(
        id,
        new UnsupportedOperationError(error.message),
      );
    } else if (error instanceof AuthorizationException) {
      const payload: JSONRPCError = {
        code: -32600,
        message: "Unauthorized",
        data: error.message,
      };
      yield createErrorResponse(id, payload);
    } else if (error instanceof RateLimitExceededException) {
      const payload: JSONRPCError = {
        code: -32029,
        message: "Rate limit exceeded",
        data: error.message,
      };
      yield createErrorResponse(id, payload);
    } else if (error instanceof AgentException) {
      yield createErrorResponse(id, new InternalError(error.message));
    } else {
      yield createErrorResponse(
        id,
        new InternalError(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}

function getRpcRegistry(
  agent: Agent,
): Map<string, { propertyKey: string; streaming: boolean }> {
  const ctor = agent.constructor as {
    rpcRegistry?: Map<string, { propertyKey: string; streaming: boolean }>;
  };
  const registry = ctor.rpcRegistry;
  return registry ?? new Map();
}

async function* handleCustomRpcRequest(
  agent: Agent,
  request: JSONRPCRequest,
): AsyncGenerator<JSONRPCResponse> {
  const registry = getRpcRegistry(agent);
  const entry = registry.get(request.method);

  if (!entry) {
    yield createErrorResponse(request.id ?? null, new MethodNotFoundError());
    return;
  }

  const handlerValue = Reflect.get(
    agent as object,
    entry.propertyKey,
  ) as unknown;
  if (typeof handlerValue !== "function") {
    yield createErrorResponse(
      request.id ?? null,
      new InternalError(`Handler '${entry.propertyKey}' is not callable`),
    );
    return;
  }

  const handler = handlerValue as (...arguments_: unknown[]) => unknown;

  const { args, kwargs } = normalizeRpcParams(request.params);

  try {
    if (entry.streaming) {
      const callArgs = [...args];
      if (Object.keys(kwargs).length > 0) {
        callArgs.push(kwargs);
      }

      const iterator = (await handler.apply(
        agent,
        callArgs,
      )) as AsyncIterable<unknown>;
      for await (const chunk of iterator) {
        yield createResultResponse(request.id ?? null, chunk);
      }
      yield createResultResponse(request.id ?? null, null);
      return;
    }

    const callArgs = [...args];
    if (Object.keys(kwargs).length > 0) {
      callArgs.push(kwargs);
    }

    const result = await handler.apply(agent, callArgs);
    yield createResultResponse(request.id ?? null, result ?? null);
  } catch (error) {
    yield createErrorResponse(
      request.id ?? null,
      new InternalError(error instanceof Error ? error.message : String(error)),
    );
  }
}

export async function* handleAgentRpcRequest(
  agent: Agent,
  rawRpcRequest: Record<string, unknown>,
): AsyncGenerator<JSONRPCResponse> {
  let genericRequest: JSONRPCRequest;

  try {
    genericRequest = JSONRPCRequestSchema.parse(rawRpcRequest);
  } catch (error) {
    const id = extractId(rawRpcRequest);
    yield createErrorResponse(
      id ?? null,
      new InvalidRequestError(
        error instanceof Error ? error.message : String(error),
      ),
    );
    return;
  }

  if (A2A_METHODS.has(genericRequest.method)) {
    yield* handleA2ARpcRequest(agent, genericRequest);
    return;
  }

  yield* handleCustomRpcRequest(agent, genericRequest);
}
