/**
 * Live State 快照契约。
 *
 * 只用手写的 stub bot，不依赖 mineflayer：快照函数永不抛错、
 * 缺字段写 null/unknown、感知有界、截图位诚实（有就引用，
 * 没有就写原因）。
 */
import { describe, expect, it } from 'vitest';
import {
  KEY_BLOCKS,
  PERCEPTION_LIMIT,
  PERCEPTION_RADIUS,
  renderLiveState,
  sampleLiveState,
} from '../src/agent/live_state.js';

function stubBot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    health: 20,
    food: 18,
    foodSaturation: 5,
    oxygenLevel: 20,
    experience: { level: 3, progress: 0.5 },
    entity: {
      id: 1,
      position: { x: 10.5, y: 64, z: -3.2 },
      yaw: 0,
      pitch: 0,
      pose: 'standing',
      onGround: true,
      velocity: { x: 0, y: 0, z: 0 },
    },
    heldItem: { name: 'diamond_sword', count: 1 },
    inventory: { slots: [] },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 6000 },
    rainState: false,
    thunderState: false,
    entities: {},
    currentWindow: null,
    ...overrides,
  };
}

describe('sampleLiveState', () => {
  it('reads body/held/position/environment off a mineflayer-shaped bot', () => {
    const s = sampleLiveState({ bot: stubBot() });
    expect(s.body.health).toBe(20);
    expect(s.body.food).toBe(18);
    expect(s.held.mainHand).toBe('diamond_swordx1');
    expect(s.position.x).toBeCloseTo(10.5);
    expect(s.position.dimension).toBe('overworld');
    expect(s.environment.timeOfDay).toBe(6000);
    expect(s.environment.weather).toBe('Clear');
    expect(s.meta.gamemode).toBe('survival');
  });

  it('never throws on an empty/garbage bot: everything degrades to null', () => {
    const s = sampleLiveState({ bot: {} });
    expect(s.body.health).toBeNull();
    expect(s.position.x).toBeNull();
    expect(s.environment.weather).toBe('Unknown');
    expect(s.entities).toEqual([]);
    expect(s.blocks).toEqual([]);
    expect(s.screenshot.ref).toBeNull();
  });

  it('lists nearby entities nearest-first and truncates past the limit', () => {
    const entities: Record<string, unknown> = {};
    for (let i = 0; i < PERCEPTION_LIMIT + 5; i++) {
      entities[String(100 + i)] = {
        id: 100 + i,
        name: 'zombie',
        position: { x: 10 + i, y: 64, z: -3 },
        health: 20,
      };
    }
    // 一个超距的，一个是自己，都不该出现。
    entities['999'] = { id: 999, name: 'skeleton', position: { x: 500, y: 64, z: 500 } };
    const s = sampleLiveState({ bot: stubBot({ entities }) });
    expect(s.entities).toHaveLength(PERCEPTION_LIMIT);
    expect(s.entitiesTruncated).toBe(5);
    const dists = s.entities.map((e) => e.distance);
    expect([...dists].sort((a, b) => a - b)).toEqual(dists);
  });

  it('thunderstorm beats rain, rain beats clear', () => {
    expect(sampleLiveState({ bot: stubBot({ thunderState: true }) }).environment.weather).toBe(
      'Thunderstorm',
    );
    expect(sampleLiveState({ bot: stubBot({ rainState: true }) }).environment.weather).toBe('Rain');
  });

  it('screenshot slot references the latest capture, or states why not', () => {
    const taken = sampleLiveState({
      bot: stubBot(),
      vision: { lastScreenshot: { file: 'screenshot_x.jpg', takenAt: Date.now() } },
    });
    expect(taken.screenshot.ref?.file).toBe('screenshot_x.jpg');
    expect(taken.screenshot.unavailableReason).toBeNull();

    const noVision = sampleLiveState({ bot: stubBot() });
    expect(noVision.screenshot.ref).toBeNull();
    expect(noVision.screenshot.unavailableReason).toBe('vision disabled');

    const neverShot = sampleLiveState({ bot: stubBot(), vision: {} });
    expect(neverShot.screenshot.unavailableReason).toBe('no screenshot taken yet');
  });

  it('key blocks are found by registry name within radius', () => {
    const bot = stubBot({
      blockAt: ({ x, y, z }: { x: number; y: number; z: number }) => {
        if (x === 12 && y === 64 && z === -3) return { name: 'diamond_ore' };
        if (x === 11 && y === 64 && z === -3) return { name: 'dirt' };
        return { name: 'air' };
      },
    });
    // blockAt for light/biome reads also runs; give it air so confidence stays sane.
    const s = sampleLiveState({ bot });
    expect(s.blocks.map((b) => b.name)).toContain('diamond_ore');
    expect(s.blocks.map((b) => b.name)).not.toContain('dirt');
    expect(KEY_BLOCKS.length).toBeGreaterThan(0);
  });
});

describe('renderLiveState', () => {
  it('renders every section with an honest screenshot line', () => {
    const text = renderLiveState(
      sampleLiveState({
        bot: stubBot(),
        vision: { lastScreenshot: { file: 's.jpg', takenAt: Date.now() } },
        goal: 'build a house',
        todos: ['gather wood'],
        currentAction: 'action:collectBlocks',
      }),
    );
    for (const head of [
      'Body:',
      'Held:',
      'Backpack',
      'Position:',
      'Environment:',
      'Nearby entities',
      'Nearby key blocks',
      'Screenshot: s.jpg',
      'Goal: build a house',
      'Meta:',
    ]) {
      expect(text).toContain(head);
    }
  });

  it('states the reason when no screenshot exists', () => {
    const text = renderLiveState(sampleLiveState({ bot: stubBot() }));
    expect(text).toContain('Screenshot: none (vision disabled)');
    expect(text).toContain(`within ${PERCEPTION_RADIUS}`);
  });
});
