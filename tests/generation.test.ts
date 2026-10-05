import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blueprintToTask,
  getBlockName,
  matrixToBlueprint,
  proceduralGeneration,
} from '../src/agent/tasks/construction_generation.js';

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('matrixToBlueprint', () => {
  it('maps matrix layers to levels with rising Y', () => {
    expect(
      matrixToBlueprint(
        [
          [['stone']],
          [['dirt']],
        ],
        [1, 2, 3],
      ),
    ).toEqual({
      levels: [
        { level: 0, coordinates: [1, 2, 3], placement: [['stone']] },
        { level: 1, coordinates: [1, 3, 3], placement: [['dirt']] },
      ],
    });
  });

  it('defaults missing cells to air', () => {
    const out = matrixToBlueprint([[[undefined as unknown as string]]], [0, 0, 0]);
    expect(out.levels[0]?.placement).toEqual([['air']]);
  });

  it('rejects invalid inputs with an exact error', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(() => matrixToBlueprint('nope' as never, [0, 0, 0])).toThrow('Invalid input format');
      expect(() => matrixToBlueprint([], [0, 0] as never)).toThrow('Invalid input format');
    } finally {
      log.mockRestore();
    }
  });
});

describe('getBlockName', () => {
  const bot = (block: { type: string } | null) => ({
    blockAt: () => block,
    registry: { blocks: { stone: { name: 'stone' } } },
  });

  it('resolves names through the registry', async () => {
    await expect(getBlockName(bot({ type: 'stone' }), { x: 1, y: 2, z: 3 })).resolves.toBe(
      'stone',
    );
  });

  it('reports air for empty space', async () => {
    await expect(getBlockName(bot(null), { x: 1, y: 2, z: 3 })).resolves.toBe('air');
  });
});

describe('blueprintToTask', () => {
  const data = {
    levels: [{ level: 0, coordinates: [0, 0, 0] as [number, number, number], placement: [['s']] }],
    materials: { stone: 10, dirt: 5, wood: 3 },
  };

  it('deals materials round-robin across agents', () => {
    const task = blueprintToTask(data, 2) as {
      initial_inventory: Record<string, Record<string, number>>;
    };
    expect(task.initial_inventory['0']).toMatchObject({ stone: 10, wood: 3 });
    expect(task.initial_inventory['1']).toMatchObject({ dirt: 5 });
    // every agent still gets tools
    expect(task.initial_inventory['0']?.diamond_pickaxe).toBe(1);
    expect(task.initial_inventory['1']?.diamond_axe).toBe(1);
  });

  it('gives everything to a lone agent', () => {
    const task = blueprintToTask(data, 1) as {
      initial_inventory: Record<string, Record<string, number>>;
    };
    expect(task.initial_inventory['0']).toMatchObject({ stone: 10, dirt: 5, wood: 3 });
  });

  it('pins the task envelope', () => {
    const task = blueprintToTask(data, 2);
    expect(task).toMatchObject({
      type: 'construction',
      goal: 'Make a structure with the blueprint below',
      agent_count: 2,
    });
    expect(task.blueprint).toBe(data);
  });
});

describe('proceduralGeneration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // NOTE: `{...Math}` drops non-enumerable methods (imul/floor/...), so the
  // stub inherits from the real Math and only overrides `random`.
  const withSeed = (seed: number): void => {
    const stub = Object.create(Math) as Math;
    stub.random = seededRandom(seed);
    vi.stubGlobal('Math', stub);
  };

  it('is deterministic for a fixed random stream', () => {
    withSeed(42);
    const a = proceduralGeneration(8, 6, 8, 2);
    withSeed(42);
    const b = proceduralGeneration(8, 6, 8, 2);
    expect(a).toEqual(b);
  });

  it('produces a structurally valid blueprint', () => {
    const bp = proceduralGeneration(8, 6, 8, 2);
    expect(bp.levels.length).toBeGreaterThan(0);
    for (const [i, level] of bp.levels.entries()) {
      expect(level.level).toBe(i);
      expect(level.coordinates).toHaveLength(3);
      const width = level.placement[0]?.length ?? 0;
      expect(width).toBeGreaterThan(0);
      for (const row of level.placement) {
        expect(row).toHaveLength(width);
        for (const cell of row) expect(typeof cell).toBe('string');
      }
    }
  });

  it('honors the start coordinate', () => {
    const bp = proceduralGeneration(6, 5, 6, 1, 3, 3, 3, 0, 'air', 0, 0, 0, [7, 8, 9]);
    expect(bp.levels[0]?.coordinates).toEqual([7, 8, 9]);
  });
});
