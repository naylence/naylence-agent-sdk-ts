import { z } from 'zod';
import {
  JSONRPCError,
  JSONRPCErrorSchema,
  JSONRPCRequest,
  JSONRPCRequestSchema,
  JSONRPCResponse,
  JSONRPCResponseSchema,
  generateId,
} from 'naylence-core';

type Metadata = Record<string, any>;

const MetadataSchema: z.ZodType<Metadata> = z.record(z.string(), z.any());

export enum TaskState {
  SUBMITTED = 'submitted',
  WORKING = 'working',
  INPUT_REQUIRED = 'input-required',
  COMPLETED = 'completed',
  CANCELED = 'canceled',
  FAILED = 'failed',
  UNKNOWN = 'unknown',
}

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  metadata: MetadataSchema.nullable().optional(),
});

export type TextPart = z.infer<typeof TextPartSchema>;

export const FileContentSchema = z
  .object({
    name: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional(),
    bytes: z.string().nullable().optional(),
    uri: z.string().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const hasBytes = value.bytes != null;
    const hasUri = value.uri != null;

    if (!hasBytes && !hasUri) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either 'bytes' or 'uri' must be present in the file data",
        path: ['bytes'],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either 'bytes' or 'uri' must be present in the file data",
        path: ['uri'],
      });
    }

    if (hasBytes && hasUri) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only one of 'bytes' or 'uri' can be present in the file data",
        path: ['bytes'],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Only one of 'bytes' or 'uri' can be present in the file data",
        path: ['uri'],
      });
    }
  });

export type FileContent = z.infer<typeof FileContentSchema>;

export const FilePartSchema = z.object({
  type: z.literal('file'),
  file: FileContentSchema,
  metadata: MetadataSchema.nullable().optional(),
});

export type FilePart = z.infer<typeof FilePartSchema>;

export const DataPartSchema = z.object({
  type: z.literal('data'),
  data: MetadataSchema,
  metadata: MetadataSchema.nullable().optional(),
});

export type DataPart = z.infer<typeof DataPartSchema>;

export const PartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  FilePartSchema,
  DataPartSchema,
]);

export type Part = z.infer<typeof PartSchema>;

export const MessageSchema = z.object({
  role: z.union([z.literal('user'), z.literal('agent')]),
  parts: z.array(PartSchema),
  metadata: MetadataSchema.nullable().optional(),
});

export type Message = z.infer<typeof MessageSchema>;

const TimestampSchema = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return new Date();
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return value;
}, z.date());

export const TaskStatusSchema = z.object({
  state: z.nativeEnum(TaskState),
  message: MessageSchema.nullable().optional(),
  timestamp: TimestampSchema.default(() => new Date()),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const ArtifactSchema = z.object({
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  parts: z.array(PartSchema),
  metadata: MetadataSchema.nullable().optional(),
  index: z.number().int().default(0),
  append: z.boolean().nullable().optional(),
  lastChunk: z.boolean().nullable().optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  sessionId: z.string().nullable().optional(),
  status: TaskStatusSchema,
  artifacts: z.array(ArtifactSchema).nullable().optional(),
  history: z.array(MessageSchema).nullable().optional(),
  metadata: MetadataSchema.nullable().optional(),
});

export type Task = z.infer<typeof TaskSchema>;

export const TaskStatusUpdateEventSchema = z.object({
  id: z.string(),
  status: TaskStatusSchema,
  final: z.boolean().default(false),
  metadata: MetadataSchema.nullable().optional(),
});

export type TaskStatusUpdateEvent = z.infer<typeof TaskStatusUpdateEventSchema>;

export const TaskArtifactUpdateEventSchema = z.object({
  id: z.string(),
  artifact: ArtifactSchema,
  metadata: MetadataSchema.nullable().optional(),
});

export type TaskArtifactUpdateEvent = z.infer<typeof TaskArtifactUpdateEventSchema>;

export const AuthenticationInfoSchema = z
  .object({
    schemes: z.array(z.string()),
    credentials: z.string().nullable().optional(),
  })
  .passthrough();

export type AuthenticationInfo = z.infer<typeof AuthenticationInfoSchema>;

export const PushNotificationConfigSchema = z.object({
  url: z.string(),
  token: z.string().nullable().optional(),
  authentication: AuthenticationInfoSchema.nullable().optional(),
});

export type PushNotificationConfig = z.infer<typeof PushNotificationConfigSchema>;

export const TaskIdParamsSchema = z.object({
  id: z.string(),
  metadata: MetadataSchema.nullable().optional(),
});

export type TaskIdParams = z.infer<typeof TaskIdParamsSchema>;

export const TaskQueryParamsSchema = TaskIdParamsSchema.extend({
  historyLength: z.number().int().optional().nullable(),
});

export type TaskQueryParams = z.infer<typeof TaskQueryParamsSchema>;

export const TaskSendParamsSchema = z.object({
  id: z.string(),
  sessionId: z.string().default(() => generateId()),
  message: MessageSchema,
  acceptedOutputModes: z.array(z.string()).nullable().optional(),
  pushNotification: PushNotificationConfigSchema.nullable().optional(),
  historyLength: z.number().int().optional().nullable(),
  metadata: MetadataSchema.nullable().optional(),
});

export type TaskSendParams = z.infer<typeof TaskSendParamsSchema>;

export const TaskPushNotificationConfigSchema = z.object({
  id: z.string(),
  pushNotificationConfig: PushNotificationConfigSchema,
});

export type TaskPushNotificationConfig = z.infer<typeof TaskPushNotificationConfigSchema>;

const createRequestSchema = <P, M extends string>(method: M, paramsSchema: z.ZodType<P>) =>
  JSONRPCRequestSchema.extend({
    method: z.literal(method),
    params: paramsSchema,
  });

export const SendTaskRequestSchema = createRequestSchema('tasks/send', TaskSendParamsSchema);
export type SendTaskRequest = JSONRPCRequest<TaskSendParams> & {
  method: 'tasks/send';
};

export const GetTaskRequestSchema = createRequestSchema('tasks/get', TaskQueryParamsSchema);
export type GetTaskRequest = JSONRPCRequest<TaskQueryParams> & {
  method: 'tasks/get';
};

export const CancelTaskRequestSchema = createRequestSchema('tasks/cancel', TaskIdParamsSchema);
export type CancelTaskRequest = JSONRPCRequest<TaskIdParams> & {
  method: 'tasks/cancel';
};

export const SetTaskPushNotificationRequestSchema = createRequestSchema(
  'tasks/pushNotification/set',
  TaskPushNotificationConfigSchema
);
export type SetTaskPushNotificationRequest = JSONRPCRequest<TaskPushNotificationConfig> & {
  method: 'tasks/pushNotification/set';
};

export const GetTaskPushNotificationRequestSchema = createRequestSchema(
  'tasks/pushNotification/get',
  TaskIdParamsSchema
);
export type GetTaskPushNotificationRequest = JSONRPCRequest<TaskIdParams> & {
  method: 'tasks/pushNotification/get';
};

export const TaskResubscriptionRequestSchema = createRequestSchema(
  'tasks/resubscribe',
  TaskIdParamsSchema
);
export type TaskResubscriptionRequest = JSONRPCRequest<TaskIdParams> & {
  method: 'tasks/resubscribe';
};

export const SendTaskStreamingRequestSchema = createRequestSchema(
  'tasks/sendSubscribe',
  TaskSendParamsSchema
);
export type SendTaskStreamingRequest = JSONRPCRequest<TaskSendParams> & {
  method: 'tasks/sendSubscribe';
};

export const StopTaskStreamingRequestSchema = createRequestSchema(
  'tasks/sendUnsubscribe',
  TaskIdParamsSchema
);
export type StopTaskStreamingRequest = JSONRPCRequest<TaskIdParams> & {
  method: 'tasks/sendUnsubscribe';
};

export const GetAgentCardRequestSchema = JSONRPCRequestSchema.extend({
  method: z.literal('agent.get_card'),
  params: z.object({}).default({}),
});
export type GetAgentCardRequest = JSONRPCRequest & {
  method: 'agent.get_card';
  params: Record<string, never>;
};

const nullableTaskSchema = TaskSchema.nullable().optional();

export const SendTaskResponseSchema = JSONRPCResponseSchema.extend({
  result: nullableTaskSchema,
});
export type SendTaskResponse = JSONRPCResponse & {
  result?: Task | null;
};

export const GetTaskResponseSchema = JSONRPCResponseSchema.extend({
  result: nullableTaskSchema,
});
export type GetTaskResponse = JSONRPCResponse & {
  result?: Task | null;
};

export const CancelTaskResponseSchema = JSONRPCResponseSchema.extend({
  result: nullableTaskSchema,
});
export type CancelTaskResponse = JSONRPCResponse & {
  result?: Task | null;
};

const nullablePushConfigSchema = TaskPushNotificationConfigSchema.nullable().optional();

export const SetTaskPushNotificationResponseSchema = JSONRPCResponseSchema.extend({
  result: nullablePushConfigSchema,
});
export type SetTaskPushNotificationResponse = JSONRPCResponse & {
  result?: TaskPushNotificationConfig | null;
};

export const GetTaskPushNotificationResponseSchema = JSONRPCResponseSchema.extend({
  result: nullablePushConfigSchema,
});
export type GetTaskPushNotificationResponse = JSONRPCResponse & {
  result?: TaskPushNotificationConfig | null;
};

const streamingResultSchema = z
  .union([TaskStatusUpdateEventSchema, TaskArtifactUpdateEventSchema])
  .nullable()
  .optional();

export const SendTaskStreamingResponseSchema = JSONRPCResponseSchema.extend({
  result: streamingResultSchema,
});
export type SendTaskStreamingResponse = JSONRPCResponse & {
  result?: TaskStatusUpdateEvent | TaskArtifactUpdateEvent | null;
};

const RequestSchemas = [
  SendTaskRequestSchema,
  GetTaskRequestSchema,
  CancelTaskRequestSchema,
  SetTaskPushNotificationRequestSchema,
  GetTaskPushNotificationRequestSchema,
  TaskResubscriptionRequestSchema,
  SendTaskStreamingRequestSchema,
  StopTaskStreamingRequestSchema,
  GetAgentCardRequestSchema,
] as const;

export const A2ARequestSchema = z.discriminatedUnion(
  'method',
  RequestSchemas.map((schema) => schema) as unknown as [
    typeof SendTaskRequestSchema,
    typeof GetTaskRequestSchema,
    typeof CancelTaskRequestSchema,
    typeof SetTaskPushNotificationRequestSchema,
    typeof GetTaskPushNotificationRequestSchema,
    typeof TaskResubscriptionRequestSchema,
    typeof SendTaskStreamingRequestSchema,
    typeof StopTaskStreamingRequestSchema,
    typeof GetAgentCardRequestSchema,
  ]
);

export type A2ARequest = z.infer<typeof A2ARequestSchema>;

export function parseA2ARequest(payload: unknown): A2ARequest {
  return A2ARequestSchema.parse(payload);
}

export function safeParseA2ARequest(payload: unknown) {
  return A2ARequestSchema.safeParse(payload);
}

export interface TaskStatusJSON extends Omit<TaskStatus, 'timestamp'> {
  timestamp: string;
}

export function serializeTaskStatus(status: TaskStatus): TaskStatusJSON {
  return {
    ...status,
    timestamp: status.timestamp.toISOString(),
  };
}

export interface TaskJSON extends Omit<Task, 'status'> {
  status: TaskStatusJSON;
}

export function serializeTask(task: Task): TaskJSON {
  return {
    ...task,
    status: serializeTaskStatus(task.status),
  };
}

class JSONRPCErrorBase extends Error implements JSONRPCError {
  readonly code: number;
  readonly data?: any;

  constructor(code: number, message: string, data?: any) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = new.target.name;
  }

  toJSON(): JSONRPCError {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}

function createRpcError(
  schema: z.ZodType<JSONRPCError>,
  defaults: {
    code: number;
    message: string;
  }
) {
  return class extends JSONRPCErrorBase {
    constructor(message = defaults.message, data?: any) {
      const parsed = schema.parse({
        code: defaults.code,
        message,
        data,
      });
      super(parsed.code, parsed.message, parsed.data);
    }
  };
}

export class JSONParseError extends createRpcError(JSONRPCErrorSchema, {
  code: -32700,
  message: 'Invalid JSON payload',
}) {}

export class InvalidRequestError extends createRpcError(JSONRPCErrorSchema, {
  code: -32600,
  message: 'Request payload validation error',
}) {}

export class MethodNotFoundError extends createRpcError(JSONRPCErrorSchema, {
  code: -32601,
  message: 'Method not found',
}) {}

export class InvalidParamsError extends createRpcError(JSONRPCErrorSchema, {
  code: -32602,
  message: 'Invalid parameters',
}) {}

export class InternalError extends createRpcError(JSONRPCErrorSchema, {
  code: -32603,
  message: 'Internal error',
}) {}

export class TaskNotFoundError extends createRpcError(JSONRPCErrorSchema, {
  code: -32001,
  message: 'Task not found',
}) {}

export class TaskNotCancelableError extends createRpcError(JSONRPCErrorSchema, {
  code: -32002,
  message: 'Task cannot be canceled',
}) {}

export class PushNotificationNotSupportedError extends createRpcError(JSONRPCErrorSchema, {
  code: -32003,
  message: 'Push Notification is not supported',
}) {}

export class UnsupportedOperationError extends createRpcError(JSONRPCErrorSchema, {
  code: -32004,
  message: 'This operation is not supported',
}) {}

export class ContentTypeNotSupportedError extends createRpcError(JSONRPCErrorSchema, {
  code: -32005,
  message: 'Incompatible content types',
}) {}

export const AgentProviderSchema = z.object({
  organization: z.string(),
  url: z.string().nullable().optional(),
});

export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean().default(false),
  pushNotifications: z.boolean().default(false),
  stateTransitionHistory: z.boolean().default(false),
});

export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const AgentAuthenticationSchema = z.object({
  schemes: z.array(z.string()),
  credentials: z.string().nullable().optional(),
});

export type AgentAuthentication = z.infer<typeof AgentAuthenticationSchema>;

export const AgentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  examples: z.array(z.string()).nullable().optional(),
  inputModes: z.array(z.string()).nullable().optional(),
  outputModes: z.array(z.string()).nullable().optional(),
});

export type AgentSkill = z.infer<typeof AgentSkillSchema>;

export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  url: z.string(),
  provider: AgentProviderSchema.nullable().optional(),
  version: z.string(),
  documentationUrl: z.string().nullable().optional(),
  capabilities: AgentCapabilitiesSchema,
  authentication: AgentAuthenticationSchema.nullable().optional(),
  defaultInputModes: z.array(z.string()).default(['text']),
  defaultOutputModes: z.array(z.string()).default(['text']),
  skills: z.array(AgentSkillSchema),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;

export class A2AClientError extends Error {}

export class A2AClientHTTPError extends A2AClientError {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`HTTP Error ${statusCode}: ${message}`);
    this.statusCode = statusCode;
  }
}

export class A2AClientJSONError extends A2AClientError {
  constructor(message: string) {
    super(`JSON Error: ${message}`);
  }
}

export class MissingAPIKeyError extends Error {}
