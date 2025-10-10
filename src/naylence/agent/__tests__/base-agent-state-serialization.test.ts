import { z } from 'zod';
import { BaseAgent, BaseAgentState } from '../base-agent';
import { InMemoryStorageProvider } from 'naylence-runtime';

// Test state without schema (uses default z.any())
class SimpleState extends BaseAgentState {
  count: number = 0;
  items: string[] = [];
}

// Test state with schema - uses base class toJSON with validation
const ValidatedStateSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(z.string()).max(10),
  lastUpdated: z.string().datetime().optional(),
});

class ValidatedState extends BaseAgentState {
  static readonly schema = ValidatedStateSchema;
  
  count: number = 0;
  items: string[] = [];
  lastUpdated?: string;
  
  // Don't override toJSON - let base class handle validation
}

// Nested state with schema validation
const NestedItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
});

const NestedStateSchema = z.object({
  items: z.array(NestedItemSchema),
  totalValue: z.number().nonnegative(),
});

class NestedState extends BaseAgentState {
  static readonly schema = NestedStateSchema;
  
  items: Array<{ id: string; name: string; quantity: number }> = [];
  totalValue: number = 0;
  
  // Don't override toJSON - let base class handle validation
}

describe('BaseAgentState - Serialization', () => {
  let provider: InMemoryStorageProvider;
  let agent: BaseAgent<SimpleState>;

  beforeEach(() => {
    provider = new InMemoryStorageProvider();
    agent = new BaseAgent<SimpleState>('test', {
      stateModel: SimpleState,
      storageProvider: provider,
    });
  });

  describe('JSON round-trip', () => {
    test('should survive simple JSON round-trip', () => {
      const state = new SimpleState();
      state.count = 100;
      state.items = ['a', 'b', 'c'];

      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);
      const restored = Object.assign(new SimpleState(), parsed);

      expect(restored.count).toBe(100);
      expect(restored.items).toEqual(['a', 'b', 'c']);
    });

    test('should handle empty state', () => {
      const state = new SimpleState();

      const json = JSON.stringify(state);
      const parsed = JSON.parse(json);

      expect(parsed.count).toBe(0);
      expect(parsed.items).toEqual([]);
    });
  });

  describe('State persistence', () => {
    test('should save and load state correctly', async () => {
      await agent.withState(async (s) => {
        s.count = 100;
        s.items = ['a', 'b', 'c'];
      });

      // Clear cache to force reload from storage
      // @ts-expect-error - accessing private field for testing
      agent._stateCache = null;

      const loaded = await agent.getState();
      
      expect(loaded.count).toBe(100);
      expect(loaded.items).toEqual(['a', 'b', 'c']);
    });

    test('should handle multiple save/load cycles', async () => {
      for (let i = 0; i < 5; i++) {
        await agent.withState(async (s) => {
          s.count = i;
        });

        // Clear cache to force reload from storage
        // @ts-expect-error - accessing private field for testing
        agent._stateCache = null;

        const loaded = await agent.getState();
        expect(loaded.count).toBe(i);
      }
    });
  });

  describe('Concurrent access', () => {
    test('should handle concurrent modifications with locking', async () => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          agent.withState(async (s) => {
            const current = s.count;
            // Small delay to create contention
            await new Promise((resolve) => setTimeout(resolve, 1));
            s.count = current + 1;
          })
        );
      }

      await Promise.all(promises);
      const final = await agent.getState();
      
      expect(final.count).toBe(10);
    });
  });
});

describe('BaseAgentState - Validation', () => {
  let provider: InMemoryStorageProvider;
  let validatedAgent: BaseAgent<ValidatedState>;

  beforeEach(() => {
    provider = new InMemoryStorageProvider();
    validatedAgent = new BaseAgent<ValidatedState>('validated', {
      stateModel: ValidatedState,
      storageProvider: provider,
    });
  });

  describe('Schema validation on serialization', () => {
    test('should validate correct data', () => {
      const state = new ValidatedState();
      state.count = 42;
      state.items = ['a', 'b', 'c'];
      state.lastUpdated = new Date().toISOString();

      expect(() => state.toJSON()).not.toThrow();
    });

    test('should reject negative count', () => {
      const state = new ValidatedState();
      state.count = -5;

      expect(() => state.toJSON()).toThrow(/Failed to serialize/);
      expect(() => state.toJSON()).toThrow(/count/);
    });

    test('should reject non-integer count', () => {
      const state = new ValidatedState();
      (state.count as any) = 42.5;

      expect(() => state.toJSON()).toThrow(/Failed to serialize/);
    });

    test('should reject too many items', () => {
      const state = new ValidatedState();
      state.items = new Array(11).fill('x');

      expect(() => state.toJSON()).toThrow(/Failed to serialize/);
      expect(() => state.toJSON()).toThrow(/items/);
    });

    test('should accept optional fields', () => {
      const state = new ValidatedState();
      state.count = 10;
      state.items = ['a'];
      // lastUpdated not set

      const json = state.toJSON();
      expect(json).toEqual({
        count: 10,
        items: ['a'],
        lastUpdated: undefined,
      });
    });
  });

  describe('Schema validation on deserialization', () => {
    test('should accept valid data', () => {
      const validData = {
        count: 42,
        items: ['a', 'b'],
        lastUpdated: new Date().toISOString(),
      };

      const state = ValidatedState.fromJSON(validData);
      expect(state.count).toBe(42);
      expect(state.items).toEqual(['a', 'b']);
    });

    test('should reject invalid type', () => {
      const invalidData = {
        count: 'not a number',
        items: [],
      };

      expect(() => ValidatedState.fromJSON(invalidData)).toThrow(/Failed to deserialize/);
      expect(() => ValidatedState.fromJSON(invalidData)).toThrow(/count/);
    });

    test('should reject out-of-range values', () => {
      const invalidData = {
        count: -10,
        items: [],
      };

      expect(() => ValidatedState.fromJSON(invalidData)).toThrow(/Failed to deserialize/);
    });

    test('should reject missing required fields', () => {
      const invalidData = {
        count: 42,
        // items missing
      };

      expect(() => ValidatedState.fromJSON(invalidData)).toThrow(/Failed to deserialize/);
    });

    test('should transform data types', () => {
      // Zod can transform types, e.g., string to Date
      const data = {
        count: 42,
        items: ['a', 'b'],
        lastUpdated: '2025-10-09T12:00:00Z',
      };

      const state = ValidatedState.fromJSON(data);
      expect(typeof state.lastUpdated).toBe('string');
    });
  });

  describe('Validation during persistence', () => {
    test('should save valid state', async () => {
      await expect(
        validatedAgent.withState(async (s) => {
          s.count = 42;
          s.items = ['a', 'b'];
        })
      ).resolves.not.toThrow();
    });

    test('should prevent saving invalid state', async () => {
      await expect(
        validatedAgent.withState(async (s) => {
          s.count = -99;
        })
      ).rejects.toThrow(/Failed to serialize/);
    });

    test('should validate on load', async () => {
      // First, save valid state to initialize everything
      await validatedAgent.withState(async (s) => {
        s.count = 42;
        s.items = ['valid'];
      });
      
      // Access the internal state store that the agent is using
      // @ts-expect-error - accessing private field for testing
      const agentStore = validatedAgent._stateStore;
      expect(agentStore).toBeDefined();
      if (!agentStore) throw new Error('Store not initialized');
      
      // Verify the valid state is there
      const validData = await agentStore.get('state');
      expect(validData).toBeDefined();
      expect((validData as any).count).toBe(42);
      
      // Corrupt it with invalid data directly in the agent's store
      await agentStore.set('state', { count: 'not a number', items: [] } as any);
      
      // Verify corruption
      const corruptedData = await agentStore.get('state');
      expect((corruptedData as any).count).toBe('not a number');

      // Clear cache to force reload
      // @ts-expect-error - accessing private field for testing
      validatedAgent._stateCache = null;

      // Should throw validation error when loading corrupted data
      await expect(validatedAgent.getState()).rejects.toThrow(/Failed to deserialize/);
    });
  });
});

describe('BaseAgentState - Nested Objects', () => {
  let provider: InMemoryStorageProvider;
  let nestedAgent: BaseAgent<NestedState>;

  beforeEach(() => {
    provider = new InMemoryStorageProvider();
    nestedAgent = new BaseAgent<NestedState>('nested', {
      stateModel: NestedState,
      storageProvider: provider,
    });
  });

  test('should validate nested object structure', () => {
    const state = new NestedState();
    state.items = [
      { id: '123e4567-e89b-12d3-a456-426614174000', name: 'Widget', quantity: 5 },
    ];
    state.totalValue = 100;

    expect(() => state.toJSON()).not.toThrow();
  });

  test('should reject invalid nested UUID', () => {
    const state = new NestedState();
    state.items = [
      { id: 'not-a-uuid', name: 'Widget', quantity: 5 },
    ];

    expect(() => state.toJSON()).toThrow(/Failed to serialize/);
    expect(() => state.toJSON()).toThrow(/id/);
  });

  test('should reject invalid nested quantity', () => {
    const state = new NestedState();
    state.items = [
      { id: '123e4567-e89b-12d3-a456-426614174000', name: 'Widget', quantity: 0 },
    ];

    expect(() => state.toJSON()).toThrow(/Failed to serialize/);
    expect(() => state.toJSON()).toThrow(/quantity/);
  });

  test('should reject empty name in nested object', () => {
    const state = new NestedState();
    state.items = [
      { id: '123e4567-e89b-12d3-a456-426614174000', name: '', quantity: 5 },
    ];

    expect(() => state.toJSON()).toThrow(/Failed to serialize/);
  });

  test('should persist complex nested state', async () => {
    await nestedAgent.withState(async (s) => {
      s.items = [
        { id: '123e4567-e89b-12d3-a456-426614174000', name: 'Widget A', quantity: 5 },
        { id: '223e4567-e89b-12d3-a456-426614174000', name: 'Widget B', quantity: 3 },
      ];
      s.totalValue = 200;
    });

    // Clear cache to force reload from storage
    // @ts-expect-error - accessing private field for testing
    nestedAgent._stateCache = null;
    
    const loaded = await nestedAgent.getState();

    expect(loaded.items).toHaveLength(2);
    expect(loaded.items[0].name).toBe('Widget A');
    expect(loaded.totalValue).toBe(200);
  });
});

describe('BaseAgentState - clone()', () => {
  test('should create validated copy of state', () => {
    const state = new ValidatedState();
    state.count = 42;
    state.items = ['a', 'b'];

    const cloned = state.clone();

    expect(cloned).not.toBe(state);
    expect(cloned.count).toBe(42);
    expect(cloned.items).toEqual(['a', 'b']);
  });

  test('should validate during clone', () => {
    const state = new ValidatedState();
    state.count = -5; // Invalid

    expect(() => state.clone()).toThrow(/Failed to serialize/);
  });

  test('should create deep copy for nested objects', () => {
    const state = new NestedState();
    state.items = [
      { id: '123e4567-e89b-12d3-a456-426614174000', name: 'Widget', quantity: 5 },
    ];

    const cloned = state.clone();
    cloned.items[0].quantity = 10;

    expect(state.items[0].quantity).toBe(5); // Original unchanged
  });
});
