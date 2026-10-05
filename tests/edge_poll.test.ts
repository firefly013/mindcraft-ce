/**
 * 快照构造器 + 请求日志：stub bot / 真 tmp 目录，不碰服务器。
 */
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { snapshotFromBot, createEdgeWatcher } from '../src/agent/edges.js';
import { createRequestLog } from '../src/agent/requestLog.js';

function stubBot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    health: 20,
    food: 15,
    oxygenLevel: 20,
    entity: {
      id: 1,
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
    inventory: { slots: [], items: () => [] },
    heldItem: null,
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    rainState: false,
    thunderState: false,
    entities: {},
    currentWindow: null,
    blockAt: () => ({ name: 'air', light: 12, skyLight: 12, biome: { name: 'plains' } }),
    ...overrides,
  };
}

describe('snapshotFromBot', () => {
  it('reads the common fields off a mineflayer-shaped bot', () => {
    const s = snapshotFromBot(stubBot(), { currentAction: 'a', goal: 'g' });
    expect(s.health).toBe(20);
    expect(s.food).toBe(15);
    expect(s.isNight).toBe(false);
    expect(s.dimension).toBe('overworld');
    expect(s.biome).toBe('plains');
    expect(s.light).toBe(12);
    expect(s.currentAction).toBe('a');
    expect(s.position).toBe('0,64,0');
  });

  it('maps players and hostiles with distances', () => {
    const s = snapshotFromBot(
      stubBot({
        entities: {
          7: { id: 7, name: 'steve', type: 'player', position: { x: 3, y: 64, z: 0 } },
          8: { id: 8, name: 'zombie', type: 'mob', position: { x: 10, y: 64, z: 0 } },
        },
      }),
    );
    expect(s.entities).toHaveLength(2);
    const player = s.entities?.find((e) => e.id === 7);
    expect(player?.isPlayer).toBe(true);
    expect(player?.distance).toBe(3);
  });

  it('reads lava contact and night from the world', () => {
    const s = snapshotFromBot(
      stubBot({
        time: { timeOfDay: 18000 },
        blockAt: () => ({ name: 'lava' }),
      }),
    );
    expect(s.isNight).toBe(true);
    expect(s.inLava).toBe(true);
    expect(s.light).toBeUndefined();
  });

  it('computes void, lethal fall and lava-ahead from position and facing', () => {
    // 脚下 -70：虚空。
    expect(snapshotFromBot(stubBot({ entity: { position: { x: 0, y: -70, z: 0 } } })).belowVoid).toBe(true);
    expect(snapshotFromBot(stubBot()).belowVoid).toBeUndefined();

    // 下落 8 格以上：致命风险；3 格：不算。
    const falling = (d: number): Record<string, unknown> =>
      stubBot({ entity: { position: { x: 0, y: 64, z: 0 }, fallDistance: d } });
    expect(snapshotFromBot(falling(9)).fallLethal).toBe(true);
    expect(snapshotFromBot(falling(3)).fallLethal).toBeUndefined();

    // 朝南（yaw=0）移动，前方两格是岩浆。
    const s = snapshotFromBot(
      stubBot({
        entity: {
          position: { x: 0, y: 64, z: 0 },
          velocity: { x: 0, y: 0, z: 1 },
          yaw: 0,
        },
        blockAt: (p: { x: number; y: number; z: number }) =>
          p.x === 0 && p.z === 2 ? { name: 'lava' } : { name: 'air' },
      }),
    );
    expect(s.moving).toBe(true);
    expect(s.nextIsLava).toBe(true);

    // 没动：不预判。
    const still = snapshotFromBot(stubBot({ entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0 } }));
    expect(still.nextIsLava).toBeUndefined();
  });

  it('reads the fire flag off entity metadata, defensively', () => {
    const burning = snapshotFromBot(
      stubBot({ entity: { position: { x: 0, y: 64, z: 0 }, metadata: [{ value: 1 }] } }),
    );
    expect(burning.onFire).toBe(true);
    const calm = snapshotFromBot(
      stubBot({ entity: { position: { x: 0, y: 64, z: 0 }, metadata: [{ value: 0 }] } }),
    );
    expect(calm.onFire).toBeUndefined();
    // 形状不对：静默，不炸。
    expect(snapshotFromBot(stubBot({ entity: { position: { x: 0, y: 64, z: 0 }, metadata: 'junk' } })).onFire).toBeUndefined();
  });

  it('computed flags drive their L5 detectors through the watcher', () => {
    const w = createEdgeWatcher();
    // 快照→检测器端到端：脚下 -70 直接打出虚空 L5。
    const snap = snapshotFromBot(stubBot({ entity: { position: { x: 0, y: -70, z: 0 } } }));
    const types = w.poll(snap).map((e) => e.type);
    expect(types).toContain('world.void.falling');
  });

  it('never throws on garbage and leaves honest gaps', () => {
    const s = snapshotFromBot(null);
    expect(s).toEqual({});
    const s2 = snapshotFromBot({}, {});
    // onFire / fallLethal 等 host 传感缺口保持 undefined（检测器静默）。
    expect(s2.onFire).toBeUndefined();
    expect(s2.fallLethal).toBeUndefined();
  });
});

describe('createRequestLog', () => {
  it('appends JSONL and rotates away', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reqlog-'));
    const log = createRequestLog({ dir });
    log.logRequest({ text: 'hello', tools: ['stats', 'Finish'] });
    log.logRequest({ text: 'world', tools: [] });
    const lines = readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).tools).toEqual(['stats', 'Finish']);

    const backup = log.rotate();
    expect(backup).not.toBeNull();
    expect(readdirSync(dir).some((f) => f.startsWith('requests-'))).toBe(true);
    expect(log.rotate()).toBeNull();
  });
});
