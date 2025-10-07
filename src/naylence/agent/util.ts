import { DataFrame } from 'naylence-core';
import type { FameMessageResponse } from 'naylence-core';
import {
  DataPart,
  DataPartSchema,
  Message,
  MessageSchema,
  Part,
  Task,
  TaskSendParams,
  TaskState,
  TaskStatus,
  TaskStatusSchema,
  TextPart,
  TextPartSchema,
} from './a2a-types.js';

export function extractId(obj: unknown): string | undefined {
  if (obj && typeof obj === 'object') {
    const candidate = obj as Record<string, unknown>;
    const value = candidate.id;
    if (typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

function decodeBase64(payload: string): Uint8Array {
  const globalAtob =
    typeof globalThis.atob === 'function' ? globalThis.atob.bind(globalThis) : null;
  if (globalAtob) {
    const binary = globalAtob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const maybeBuffer = (globalThis as Record<string, unknown>).Buffer as
    | { from(input: string, encoding: string): ArrayLike<number> | Uint8Array }
    | undefined;
  if (maybeBuffer && typeof maybeBuffer.from === 'function') {
    const buffer = maybeBuffer.from(payload, 'base64');
    return buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer);
  }

  throw new Error('Base64 decoding is not supported in this environment');
}

export function decodeFameDataPayload(frame: DataFrame): unknown {
  if (frame.codec === 'b64' && typeof frame.payload === 'string') {
    return decodeBase64(frame.payload);
  }
  return frame.payload;
}

export function firstDataPart(message: Message | null | undefined): Record<string, unknown> | null {
  if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
    return null;
  }

  const first = message.parts[0];
  const parsed = DataPartSchema.safeParse(first);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.data;
}

export function firstTextPart(message: Message | null | undefined): string | null {
  if (!message || !Array.isArray(message.parts) || message.parts.length === 0) {
    return null;
  }

  const first = message.parts[0];
  const parsed = TextPartSchema.safeParse(first);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.text ?? null;
}

export interface MakeTaskParamsOptions {
  id: string;
  role?: Message['role'];
  payload?: Record<string, unknown> | string | null;
  sessionId?: string | null;
  acceptedOutputModes?: string[] | null;
  pushNotification?: TaskSendParams['pushNotification'];
  historyLength?: number | null;
  metadata?: Record<string, unknown> | null;
}

export function makeTaskParams(options: MakeTaskParamsOptions): TaskSendParams {
  const {
    id,
    role = 'agent',
    payload = null,
    sessionId = null,
    acceptedOutputModes = null,
    pushNotification = null,
    historyLength = null,
    metadata = null,
  } = options;

  let part: Part;
  if (typeof payload === 'string') {
    part = {
      type: 'text',
      text: payload,
      metadata: null,
    } satisfies TextPart;
  } else {
    part = {
      type: 'data',
      data: payload ?? {},
      metadata: null,
    } satisfies DataPart;
  }

  const message: Message = MessageSchema.parse({
    role,
    parts: [part],
    metadata: null,
  });

  const params: TaskSendParams = {
    id,
    sessionId: sessionId ?? id,
    message,
    acceptedOutputModes: acceptedOutputModes ?? undefined,
    pushNotification: pushNotification ?? undefined,
    historyLength: historyLength ?? undefined,
    metadata: metadata ?? undefined,
  };

  return params;
}

export interface MakeTaskOptions {
  id: string;
  role?: Message['role'];
  state?: TaskState;
  payload: Record<string, unknown> | string | null;
  sessionId?: string | null;
}

export function makeTask(options: MakeTaskOptions): Task {
  const { id, role = 'agent', state = TaskState.WORKING, payload, sessionId = null } = options;

  const message = makeMessage(payload, role);

  const status: TaskStatus = TaskStatusSchema.parse({
    state,
    message,
    timestamp: new Date(),
  });

  return {
    id,
    sessionId: sessionId ?? id,
    status,
    artifacts: null,
    history: message ? [message] : null,
    metadata: null,
  };
}

export function makeMessage(
  payload: Record<string, unknown> | string | null,
  role: Message['role'] = 'agent'
): Message | null {
  if (payload === null || payload === undefined) {
    return null;
  }

  let parts: Part[];
  if (typeof payload === 'string') {
    parts = [TextPartSchema.parse({ type: 'text', text: payload, metadata: null })];
  } else {
    parts = [DataPartSchema.parse({ type: 'data', data: payload, metadata: null })];
  }

  return MessageSchema.parse({
    role,
    parts,
    metadata: null,
  });
}

export type { FameMessageResponse };
