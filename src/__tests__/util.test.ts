import { describe, expect, it, afterEach } from '@jest/globals';
import { DataFrame } from '@naylence/core';
import {
  DataPartSchema,
  MessageSchema,
  TaskState,
  TextPartSchema,
} from '../naylence/agent/a2a-types.js';
import {
  decodeFameDataPayload,
  firstTextPart,
  makeMessage,
  makeTask,
  makeTaskParams,
} from '../naylence/agent/util.js';

const globalAny = globalThis as typeof globalThis & Record<string, any>;

describe('decodeFameDataPayload', () => {
  const originalAtob = globalAny.atob;
  const originalBuffer = globalAny.Buffer;

  afterEach(() => {
    if (originalAtob === undefined) {
      Reflect.deleteProperty(globalAny, 'atob');
    } else {
      globalAny.atob = originalAtob;
    }

    if (originalBuffer === undefined) {
      Reflect.deleteProperty(globalAny, 'Buffer');
    } else {
      globalAny.Buffer = originalBuffer;
    }
  });

  it('decodes payload using global atob when available', () => {
    const payload = 'ignored';
    const binary = '\u0001\u0002\u0003';
    const atobMock = jest.fn(() => binary);
    globalAny.atob = atobMock;
    Reflect.deleteProperty(globalAny, 'Buffer');

    const frame = { type: 'Data', codec: 'b64', payload } as DataFrame;
    const result = decodeFameDataPayload(frame);

    expect(atobMock).toHaveBeenCalledWith(payload);
    expect(result).toBeInstanceOf(Uint8Array);
    const bytes = result as Uint8Array;
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('falls back to Buffer when atob is unavailable and returns the buffer directly', () => {
    Reflect.deleteProperty(globalAny, 'atob');
    const fromMock = jest.fn(() => new Uint8Array([5, 6]));
    globalAny.Buffer = { from: fromMock } as any;

    const frame = { type: 'Data', codec: 'b64', payload: 'unused' } as DataFrame;
    const result = decodeFameDataPayload(frame);

    expect(fromMock).toHaveBeenCalledWith('unused', 'base64');
    expect(result).toBeInstanceOf(Uint8Array);
    const bytes = result as Uint8Array;
    expect(Array.from(bytes)).toEqual([5, 6]);
  });

  it('converts array-like values from Buffer.from into a Uint8Array', () => {
    Reflect.deleteProperty(globalAny, 'atob');
    const arrayLike = { length: 3, 0: 7, 1: 8, 2: 9 };
    const fromMock = jest.fn(() => arrayLike);
    globalAny.Buffer = { from: fromMock } as any;

    const frame = { type: 'Data', codec: 'b64', payload: 'unused' } as DataFrame;
    const result = decodeFameDataPayload(frame);

    const bytes = result as Uint8Array;
    expect(Array.from(bytes)).toEqual([7, 8, 9]);
  });

  it('throws when no base64 decoder is available', () => {
    Reflect.deleteProperty(globalAny, 'atob');
    Reflect.deleteProperty(globalAny, 'Buffer');

    const frame = { type: 'Data', codec: 'b64', payload: 'unused' } as DataFrame;

    expect(() => decodeFameDataPayload(frame)).toThrow(
      'Base64 decoding is not supported in this environment'
    );
  });

  it('returns the original payload when codec is not base64', () => {
    const payload = { hello: 'world' };
    const frame = { type: 'Data', codec: 'json', payload } as DataFrame;

    const result = decodeFameDataPayload(frame);

    expect(result).toBe(payload);
  });
});

describe('firstTextPart', () => {
  it('returns null when message is missing', () => {
    expect(firstTextPart(null)).toBeNull();
    expect(firstTextPart(undefined)).toBeNull();
  });

  it('returns null when message has no parts', () => {
    const message = MessageSchema.parse({ role: 'agent', parts: [], metadata: null });
    expect(firstTextPart(message)).toBeNull();
  });

  it('returns null when the first part is not text', () => {
    const dataPart = DataPartSchema.parse({ type: 'data', data: {}, metadata: null });
    const message = MessageSchema.parse({
      role: 'agent',
      parts: [dataPart],
      metadata: null,
    });
    expect(firstTextPart(message)).toBeNull();
  });

  it('returns the text content when parsing succeeds', () => {
    const textPart = TextPartSchema.parse({
      type: 'text',
      text: 'hello world',
      metadata: null,
    });
    const message = MessageSchema.parse({
      role: 'user',
      parts: [textPart],
      metadata: null,
    });

    expect(firstTextPart(message)).toBe('hello world');
  });
});

describe('makeTaskParams', () => {
  it('creates a text part when payload is a string and defaults optional fields', () => {
    const params = makeTaskParams({ id: 'task-1', payload: 'hello' });

    expect(params.sessionId).toBe('task-1');
    expect(params.message.parts[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(params.acceptedOutputModes).toBeUndefined();
    expect(params.pushNotification).toBeUndefined();
    expect(params.historyLength).toBeUndefined();
    expect(params.metadata).toBeUndefined();
  });

  it('creates a data part and preserves provided optional fields', () => {
    const params = makeTaskParams({
      id: 'task-2',
      payload: { value: 42 },
      sessionId: 'session-1',
      acceptedOutputModes: ['stream'],
      pushNotification: { url: 'https://example.com' },
      historyLength: 5,
      metadata: { source: 'test' },
    });

    expect(params.sessionId).toBe('session-1');
    expect(params.message.parts[0]).toMatchObject({ type: 'data', data: { value: 42 } });
    expect(params.acceptedOutputModes).toEqual(['stream']);
    expect(params.pushNotification).toEqual({ url: 'https://example.com' });
    expect(params.historyLength).toBe(5);
    expect(params.metadata).toEqual({ source: 'test' });
  });
});

describe('makeMessage', () => {
  it('returns null when payload is null or undefined', () => {
    expect(makeMessage(null, 'agent')).toBeNull();
    expect(makeMessage(undefined as any, 'agent')).toBeNull();
  });

  it('creates a message with a text part for string payloads', () => {
    const message = makeMessage('hello', 'user');
    expect(message).not.toBeNull();
    expect(message?.parts[0]).toMatchObject({ type: 'text', text: 'hello' });
    expect(message?.role).toBe('user');
  });

  it('creates a message with a data part for object payloads', () => {
    const payload = { answer: 42 };
    const message = makeMessage(payload, 'agent');
    expect(message).not.toBeNull();
    expect(message?.parts[0]).toMatchObject({ type: 'data', data: payload });
  });
});

describe('makeTask', () => {
  it('populates history and preserves session id when provided', () => {
    const task = makeTask({
      id: 'task-3',
      payload: 'payload',
      role: 'user',
      sessionId: 'session-3',
      state: TaskState.SUBMITTED,
    });

    expect(task.sessionId).toBe('session-3');
    expect(task.history).not.toBeNull();
    expect(task.history?.[0].parts[0]).toMatchObject({ type: 'text', text: 'payload' });
    expect(task.status.state).toBe(TaskState.SUBMITTED);
    expect(task.status.message?.parts[0]).toMatchObject({ type: 'text', text: 'payload' });
  });

  it('uses the task id as the session id and leaves history null when message is null', () => {
    const task = makeTask({ id: 'task-4', payload: null });

    expect(task.sessionId).toBe('task-4');
    expect(task.history).toBeNull();
    expect(task.status.message).toBeNull();
  });
});
