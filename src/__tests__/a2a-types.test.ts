import {
  FileContentSchema,
  FilePartSchema,
  TaskSendParamsSchema,
  TaskStatusSchema,
  TaskStatusUpdateEventSchema,
  parseA2ARequest,
  safeParseA2ARequest,
  serializeTaskStatus,
  serializeTask,
  JSONParseError,
  InvalidRequestError,
  TaskNotFoundError,
  AgentCardSchema,
  MessageSchema,
  TaskSchema,
  SendTaskRequestSchema,
  A2AClientHTTPError,
  A2AClientJSONError,
  MissingAPIKeyError,
} from '../naylence/agent/a2a-types.js';

describe('a2a-types', () => {
  const message = {
    role: 'user' as const,
    parts: [
      {
        type: 'text' as const,
        text: 'hello',
      },
    ],
  };

  it('validates FileContent bytes and uri exclusivity', () => {
    expect(() =>
      FileContentSchema.parse({
        bytes: 'ZmlsZS1ieXRlcy==',
      })
    ).not.toThrow();

    expect(() =>
      FileContentSchema.parse({
        uri: 'https://example.com/file.txt',
      })
    ).not.toThrow();

    expect(() => FileContentSchema.parse({})).toThrow(
      "Either 'bytes' or 'uri' must be present in the file data"
    );

    expect(() =>
      FileContentSchema.parse({
        bytes: 'ZmlsZS1ieXRlcy==',
        uri: 'https://example.com/file.txt',
      })
    ).toThrow("Only one of 'bytes' or 'uri' can be present in the file data");
  });

  it('parses composite parts with metadata', () => {
    const part = FilePartSchema.parse({
      type: 'file',
      file: { uri: 'https://example.com' },
      metadata: { kind: 'image' },
    });

    expect(part.file.uri).toBe('https://example.com');
    expect(part.metadata?.kind).toBe('image');
  });

  it('assigns default timestamp and serializes TaskStatus', () => {
    const status = TaskStatusSchema.parse({
      state: 'submitted',
      message,
    });

    const serialized = serializeTaskStatus(status);
    expect(serialized.timestamp).toMatch(/Z$/);
    expect(new Date(serialized.timestamp).getTime()).not.toBeNaN();
  });

  it('accepts ISO timestamp input', () => {
    const status = TaskStatusSchema.parse({
      state: 'completed',
      timestamp: '2024-10-01T12:34:56.789Z',
    });

    expect(status.timestamp.toISOString()).toBe('2024-10-01T12:34:56.789Z');
  });

  it('accepts Date and numeric timestamp inputs', () => {
    const explicit = new Date('2024-11-01T00:00:00.000Z');
    const fromDate = TaskStatusSchema.parse({
      state: 'working',
      timestamp: explicit,
    });

    expect(fromDate.timestamp).toBe(explicit);

    const millis = 1_726_093_056_789;
    const fromNumber = TaskStatusSchema.parse({
      state: 'failed',
      timestamp: millis,
    });

    expect(fromNumber.timestamp.getTime()).toBe(millis);
  });

  it('rejects invalid timestamp inputs', () => {
    expect(() =>
      TaskStatusSchema.parse({
        state: 'completed',
        timestamp: 'not-a-date',
      })
    ).toThrow('Invalid input: expected date, received string');
  });

  it('applies defaults in TaskStatusUpdateEvent', () => {
    const event = TaskStatusUpdateEventSchema.parse({
      id: 'task-1',
      status: {
        state: 'submitted',
      },
    });

    expect(event.final).toBe(false);
    expect(event.status.timestamp).toBeInstanceOf(Date);
  });

  it('ensures TaskSendParams defaults session id and validates nested message', () => {
    const params = TaskSendParamsSchema.parse({
      id: 'task-123',
      message,
    });

    expect(typeof params.sessionId).toBe('string');
    expect(params.sessionId.length).toBeGreaterThan(0);
  });

  it('parses A2A send request via discriminated union', () => {
    const request = parseA2ARequest({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'tasks/send',
      params: {
        id: 'task-1',
        message,
      },
    });

    expect(request.method).toBe('tasks/send');
    if (request.method !== 'tasks/send') {
      throw new Error('Expected tasks/send method');
    }
    const firstPart = request.params.message.parts[0];
    if (firstPart.type !== 'text') {
      throw new Error('Expected text message part');
    }
    expect(firstPart.text).toBe('hello');
  });

  it('rejects unsupported methods in A2A union', () => {
    const result = safeParseA2ARequest({
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'tasks/unknown',
      params: {},
    });

    expect(result.success).toBe(false);
  });

  it('serializes AgentCard defaults and nested data', () => {
    const card = AgentCardSchema.parse({
      name: 'Test Agent',
      url: 'https://agents.test',
      version: '1.0.0',
      capabilities: {},
      skills: [
        {
          id: 'skill-1',
          name: 'Example',
        },
      ],
    });

    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.capabilities.streaming).toBe(false);
  });

  it('exposes JSON-RPC error subclasses with structured payloads', () => {
    const parseError = new JSONParseError();
    const invalid = new InvalidRequestError('Bad payload', { reason: 'nope' });
    const notFound = new TaskNotFoundError();

    expect(parseError.toJSON()).toEqual({
      code: -32700,
      message: 'Invalid JSON payload',
      data: undefined,
    });
    expect(invalid.toJSON()).toEqual({
      code: -32600,
      message: 'Bad payload',
      data: { reason: 'nope' },
    });
    expect(notFound.toJSON()).toEqual({
      code: -32001,
      message: 'Task not found',
      data: undefined,
    });
  });

  it('parses Task and SendTask request consistently', () => {
    const task = TaskSchema.parse({
      id: 'task-99',
      status: { state: 'submitted' },
    });

    expect(task.status.state).toBe('submitted');

    const request = SendTaskRequestSchema.parse({
      jsonrpc: '2.0',
      id: 'req-99',
      method: 'tasks/send',
      params: {
        id: 'task-99',
        message,
      },
    });

    if (request.method !== 'tasks/send') {
      throw new Error('Expected tasks/send request');
    }
    expect(request.params.id).toBe('task-99');
  });

  it('serializes Task through helper', () => {
    const task = TaskSchema.parse({
      id: 'task-json',
      status: { state: 'working', timestamp: '2024-01-01T00:00:00.000Z' },
    });

    const serialized = serializeTask(task);

    expect(serialized.status.timestamp).toBe('2024-01-01T00:00:00.000Z');
    expect(serialized.id).toBe('task-json');
  });

  it('requires message parts are valid', () => {
    expect(() =>
      MessageSchema.parse({
        role: 'user',
        parts: [
          {
            type: 'file',
            file: {},
          },
        ],
      })
    ).toThrow("Either 'bytes' or 'uri' must be present in the file data");
  });

  it('surfaces client error helpers', () => {
    const httpError = new A2AClientHTTPError(418, 'Teapot');
    expect(httpError.message).toBe('HTTP Error 418: Teapot');
    expect(httpError.statusCode).toBe(418);

    const jsonError = new A2AClientJSONError('Bad JSON');
    expect(jsonError.message).toBe('JSON Error: Bad JSON');

    expect(new MissingAPIKeyError()).toBeInstanceOf(Error);
  });
});
