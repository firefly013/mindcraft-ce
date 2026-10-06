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
    // 真 mineflayer 给的是数字等级（rain.js 初值 0），不是布尔。
    rainState: 0,
    thunderState: 0,
    entities: {},
    currentWindow: null,
    // 真形状：`light` 是方块光（这里 0 = 没有光源），`skyLight` 是天光。
    blockAt: () => ({ name: 'air', light: 0, skyLight: 15, biome: { name: 'plains' } }),
    ...overrides,
  };
}

describe('snapshotFromBot', () => {
  /**
   * 回归线：mineflayer 的 blockAt 把参数原样交给 prismarine-world，而后者在
   * 区块已加载时会执行 `pos.floored()` —— 传 plain {x,y,z} 会抛 TypeError，
   * 被 snapshotFromBot 的 try/catch 吞掉后 light/inLava/nextIsLava 全部静默
   * 变成 undefined（L5 岩浆/溺水检测在生产永不触发）。所以这里钉住"必须是 Vec3"。
   */
  it('passes a Vec3 to bot.blockAt, never a plain object', () => {
    const seen: unknown[] = [];
    snapshotFromBot(
      stubBot({
        entity: { position: { x: 0.5, y: 64, z: -1.5 }, velocity: { x: 0, y: 0, z: 1 }, yaw: Math.PI },
        blockAt: (p: unknown) => {
          seen.push(p);
          return { name: 'air' };
        },
      }),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) {
      expect(typeof (p as { floored?: unknown }).floored).toBe('function');
    }
  });

  it('reads thunder off the numeric thunderState level', () => {
    expect(snapshotFromBot(stubBot({ thunderState: 1, rainState: 1 })).isThunder).toBe(true);
    expect(snapshotFromBot(stubBot({ thunderState: 0, rainState: 0 })).isThunder).toBeUndefined();
  });

  it('reads the common fields off a mineflayer-shaped bot', () => {
    const s = snapshotFromBot(stubBot(), { currentAction: 'a', goal: 'g' });
    expect(s.health).toBe(20);
    expect(s.food).toBe(15);
    expect(s.isNight).toBe(false);
    expect(s.dimension).toBe('overworld');
    expect(s.biome).toBe('plains');
    // 白天露天：方块光 0 + 天光 15 → 有效光照 15（以前 `light ?? skyLight`
    // 会拿到方块光的 0，正午报"漆黑"）。
    expect(s.light).toBe(15);
    expect(s.currentAction).toBe('a');
    expect(s.position).toBe('0,64,0');
  });

  it('drops the sky contribution at night and keeps torch light', () => {
    // 夜里天光不照亮：同一列数据（light 0 / skyLight 15）应当报 0。
    const night = snapshotFromBot(stubBot({ time: { timeOfDay: 18000 } }));
    expect(night.isNight).toBe(true);
    expect(night.light).toBe(0);
    // 火把光不受时辰影响。
    const torch = snapshotFromBot(
      stubBot({
        time: { timeOfDay: 18000 },
        blockAt: () => ({ name: 'air', light: 14, skyLight: 15, biome: { name: 'plains' } }),
      }),
    );
    expect(torch.light).toBe(14);
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

    // 高坠：mineflayer 没有 fallDistance，判据是"离地 + 下落速度够快"。
    const falling = (vy: number, onGround: boolean): Record<string, unknown> =>
      stubBot({ entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: vy, z: 0 }, onGround } });
    expect(snapshotFromBot(falling(-1.2, false)).fallLethal).toBe(true);
    expect(snapshotFromBot(falling(-0.5, false)).fallLethal).toBeUndefined();
    // 已经落地：不是坠落风险。
    expect(snapshotFromBot(falling(-1.2, true)).fallLethal).toBeUndefined();
    // 回归线：`fallDistance` 不是 mineflayer 的字段，光有它不能触发
    // （以前正是读了这个不存在的字段，导致 L5 world.fall.lethal 永不触发）。
    const fakeField = stubBot({ entity: { position: { x: 0, y: 64, z: 0 }, fallDistance: 99 } });
    expect(snapshotFromBot(fakeField).fallLethal).toBeUndefined();

    // 朝向用 mineflayer 弧度：0 = 北(-Z)，π = 南(+Z)。
    // 前方两格是岩浆 → 预判；岩浆在背后 → 不预判。
    const ahead = (yaw: number, lava: { x: number; z: number }): Record<string, unknown> =>
      stubBot({
        entity: { position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 1 }, yaw },
        blockAt: (p: { x: number; y: number; z: number }) =>
          p.x === lava.x && p.z === lava.z ? { name: 'lava' } : { name: 'air' },
      });

    const south = snapshotFromBot(ahead(Math.PI, { x: 0, z: 2 }));
    expect(south.moving).toBe(true);
    expect(south.nextIsLava).toBe(true);

    const north = snapshotFromBot(ahead(0, { x: 0, z: -2 }));
    expect(north.nextIsLava).toBe(true);

    // 同一处岩浆，但它在背后（朝北时南边两格）：不算。
    expect(snapshotFromBot(ahead(0, { x: 0, z: 2 })).nextIsLava).toBeUndefined();

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

  it('names a player by username, not by the literal type name', () => {
    // mineflayer 的 addNewPlayer 写死 entity.name = 'player'，身份在 username。
    const snap = snapshotFromBot(
      stubBot({
        entities: {
          8: { id: 8, type: 'player', name: 'player', username: 'Steve', position: { x: 3, y: 64, z: 0 } },
        },
      }),
    );
    expect(snap.entities?.[0]?.name).toBe('Steve');
    expect(snap.entities?.[0]?.isPlayer).toBe(true);
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
