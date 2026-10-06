/**
 * 边沿触发契约。
 *
 * 核心就一句话：条件 false→true 发一次，复位前再满足也不重发。
 * 用例覆盖滞回、按 key 独立、离散去重、变化基线、动态升降级。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyToolFailure,
  createEdgeWatcher,
  facingDelta,
  isHeartbeatDue,
  isStuck,
  isWeaponItem,
  lockOnYaw,
  resolvePriority,
  schedulerLevelFor,
  shouldEmitHurt,
  snapshotFromBot,
  CREEPER_SWELL_DIR_INDEX,
  HEARTBEAT_MS,
  HURT_DEBOUNCE_MS,
  STUCK_MS,
} from '../src/agent/edges.js';
import type { EdgeSnapshot } from '../src/agent/edges.js';
import { LEVEL } from '../src/agent/scheduler.js';

const ent = (id: number, distance: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'zombie',
  distance,
  ...extra,
});

describe('hysteresis: fire once, reset, fire again', () => {
  it('health_low fires at <=6, stays silent inside the band, refires after reset', () => {
    const w = createEdgeWatcher();
    expect(w.poll({ health: 5 }).map((e) => e.type)).toContain('bot.health_low');
    // 滞回区里徘徊：不再触发。
    expect(w.poll({ health: 7 })).toEqual([]);
    expect(w.poll({ health: 11 })).toEqual([]);
    // 回到 12 以上复位，再掉下去才发第二次。
    expect(w.poll({ health: 12 })).toEqual([]);
    expect(w.poll({ health: 5 }).map((e) => e.type)).toContain('bot.health_low');
  });

  it('missing readings never fire', () => {
    const w = createEdgeWatcher();
    expect(w.poll({})).toEqual([]);
    expect(w.poll({ health: null })).toEqual([]);
  });
});

describe('keyed detectors: one armed state per object', () => {
  it('two zombies fire independently; one leaving does not block the other', () => {
    const w = createEdgeWatcher();
    const first = w.poll({ entities: [ent(1, 10), ent(2, 50)] });
    expect(first.filter((e) => e.type === 'entity.hostile_nearby')).toHaveLength(1);

    // 1 号在 32~40 滞回区里晃：不重发；2 号走进来：发。
    const second = w.poll({ entities: [ent(1, 35), ent(2, 20)] });
    expect(second.filter((e) => e.type === 'entity.hostile_nearby').map((e) => e.key)).toEqual([2]);

    // 1 号彻底离开 40 格再回来：再发一次。
    expect(w.poll({ entities: [ent(1, 50)] })).toEqual([]);
    const third = w.poll({ entities: [ent(1, 10)] });
    expect(third.filter((e) => e.type === 'entity.hostile_nearby').map((e) => e.key)).toEqual([1]);
  });

  it('a dead entity disarms silently without an event', () => {
    const w = createEdgeWatcher();
    w.poll({ entities: [ent(1, 10)] });
    // 实体消失：不产生事件，只是解 armed。
    expect(w.poll({ entities: [] })).toEqual([]);
    // 同 id 再出现：当作新进入再发。
    expect(
      w.poll({ entities: [ent(1, 10)] }).filter((e) => e.type === 'entity.hostile_nearby'),
    ).toHaveLength(1);
  });

  it('hostile_far is keyed by TYPE, not by entity id', () => {
    // 「远处有敌对生物」是一类事实：同一种怪无论几只，只报一次。
    // 按 id 做边缘会刷屏——站夜里一分钟十几只怪各报一次（日志里就是这样）。
    const w = createEdgeWatcher();
    const far = (id: number, d: number, name = 'zombie') => ({ id, name, distance: d });

    const first = w.poll({ entities: [far(1, 50), far(2, 60), far(3, 40)] });
    expect(first.filter((e) => e.type === 'entity.hostile_far')).toHaveLength(1);
    expect(first.find((e) => e.type === 'entity.hostile_far')?.key).toBe('zombie');

    // 又一只同类走进远区：仍在 arm 状态，不重发。
    expect(
      w.poll({ entities: [far(1, 50), far(4, 55)] }).filter((e) => e.type === 'entity.hostile_far'),
    ).toEqual([]);

    // 同类全部离开 64 才解除；再进来才再报一次。
    expect(
      w.poll({ entities: [far(1, 70)] }).filter((e) => e.type === 'entity.hostile_far'),
    ).toEqual([]);
    expect(
      w.poll({ entities: [far(1, 50)] }).filter((e) => e.type === 'entity.hostile_far'),
    ).toHaveLength(1);
  });

  it('hostile_far keeps different types on independent edges', () => {
    const w = createEdgeWatcher();
    const far = (id: number, d: number, name: string) => ({ id, name, distance: d });
    const fired = w
      .poll({ entities: [far(1, 50, 'zombie'), far(2, 55, 'skeleton')] })
      .filter((e) => e.type === 'entity.hostile_far')
      .map((e) => e.key)
      .sort();
    expect(fired).toEqual(['skeleton', 'zombie']);
  });

  it('hostile_far ignores mobs inside the perception radius', () => {
    const w = createEdgeWatcher();
    // 32 以内属于 hostile_nearby 的辖区，远区不该抢报。
    expect(w.poll({ entities: [ent(1, 20)] }).filter((e) => e.type === 'entity.hostile_far')).toEqual(
      [],
    );
  });

  it('durability_low stays armed while the hand flickers between tools', () => {
    // 砍树/合成时手上来回切：换到没有耐久的东西不该把边缘解除，
    // 否则每换回一次旧镐子就再报一次——而它是 L3，每次都拉起一次请求。
    const w = createEdgeWatcher();
    const hand = (fraction: number | null) => ({
      heldSlots: fraction == null ? undefined : [{ slot: 'hand', fraction }],
    });
    expect(w.poll(hand(0.05)).map((e) => e.type)).toContain('tool.durability_low');
    // 换成方块（没有耐久数据）：边缘保持 armed，不再报。
    expect(w.poll(hand(null)).filter((e) => e.type === 'tool.durability_low')).toEqual([]);
    // 换回同一把快坏的镐子：仍然不报。
    expect(w.poll(hand(0.05)).filter((e) => e.type === 'tool.durability_low')).toEqual([]);
    // 真正修好/换新（耐久回到 30% 以上）才解除；之后再坏才再报。
    expect(w.poll(hand(0.8)).filter((e) => e.type === 'tool.durability_low')).toEqual([]);
    expect(w.poll(hand(0.05)).map((e) => e.type)).toContain('tool.durability_low');
  });

  it('player.nearby uses its own 5/8 band per player', () => {
    const w = createEdgeWatcher();
    const player = (id: number, d: number) => ({ id, name: 'steve', kind: 'player', distance: d });
    expect(w.poll({ entities: [player(7, 4)] }).map((e) => e.type)).toContain('player.nearby');
    expect(w.poll({ entities: [player(7, 6)] })).toEqual([]);
    expect(w.poll({ entities: [player(7, 9)] })).toEqual([]);
    expect(w.poll({ entities: [player(7, 4)] }).map((e) => e.type)).toContain('player.nearby');
  });
});

describe('discrete pushes: dedup by id, no arming', () => {
  it('same message id twice yields one event', () => {
    const w = createEdgeWatcher();
    const first = w.discrete('player.chat.mention', 'm1', 3, { text: 'hi' });
    expect(first).not.toBeNull();
    expect(first?.key).toBe('m1');
    expect(w.discrete('player.chat.mention', 'm1', 3, { text: 'hi' })).toBeNull();
    expect(w.discrete('player.chat.mention', 'm2', 3)).not.toBeNull();
  });
});

describe('change detectors: baseline silently, fire on transition', () => {
  it('dimension_change ignores the first sighting, fires on switch', () => {
    const w = createEdgeWatcher();
    expect(w.poll({ dimension: 'overworld' })).toEqual([]);
    expect(w.poll({ dimension: 'overworld' })).toEqual([]);
    expect(w.poll({ dimension: 'the_nether' }).map((e) => e.type)).toContain(
      'world.dimension_change',
    );
    expect(w.poll({ dimension: 'the_nether' })).toEqual([]);
  });

  it('respawn fires exactly on false->true', () => {
    const w = createEdgeWatcher();
    expect(w.poll({ alive: true })).toEqual([]);
    expect(w.poll({ alive: false }).map((e) => e.type)).toContain('agent.death');
    expect(w.poll({ alive: true }).map((e) => e.type)).toContain('agent.respawn');
    expect(w.poll({ alive: true })).toEqual([]);
  });
});

describe('flags: edge on boolean contact', () => {
  it('lava contact fires once until clear', () => {
    const w = createEdgeWatcher();
    expect(w.poll({ inLava: true }).map((e) => e.type)).toContain('world.lava.contact');
    expect(w.poll({ inLava: true })).toEqual([]);
    expect(w.poll({ inLava: false })).toEqual([]);
    expect(w.poll({ inLava: true }).map((e) => e.type)).toContain('world.lava.contact');
  });
});

describe('resolvePriority: defaults are starting points', () => {
  const snap: EdgeSnapshot = {
    health: 3,
    entities: [{ id: 1, name: 'zombie', distance: 2 }],
  };

  it('face-hugging hostile at critical health escalates to 5', () => {
    expect(resolvePriority({ type: 'entity.hostile_nearby', level: 3, key: 1 }, snap)).toBe(5);
  });

  it('emergency stop words in chat escalate to 4', () => {
    expect(
      resolvePriority({ type: 'player.chat.mention', level: 3, text: '快停下，有危险！' }, snap),
    ).toBe(4);
    expect(resolvePriority({ type: 'player.chat.mention', level: 3, text: 'hello' }, snap)).toBe(3);
  });

  it('armed player nearby at low health escalates to 4', () => {
    const s: EdgeSnapshot = {
      health: 5,
      entities: [{ id: 9, name: 'steve', kind: 'player', distance: 3, heldWeapon: true }],
    };
    expect(resolvePriority({ type: 'player.nearby', level: 3, key: 9 }, s)).toBe(4);
  });

  it('side-effect-free navigation failure steps down to 3', () => {
    expect(
      resolvePriority({ type: 'tool.action.failed', level: 4, tool: 'navigate' }, {}),
    ).toBe(3);
    expect(
      resolvePriority({ type: 'tool.action.failed', level: 4, tool: 'place', sideEffect: true }, {}),
    ).toBe(4);
  });

  it('classifyToolFailure defaults to interrupt level', () => {
    expect(classifyToolFailure({})).toBe(4);
    expect(classifyToolFailure({ tool: 'navigate' })).toBe(3);
  });
});

describe('schedulerLevelFor: edge level to dispatch level', () => {
  it('maps 5/4/3 and folds the rest to STATE', () => {
    expect(schedulerLevelFor(5)).toBe(LEVEL.EMERGENCY);
    expect(schedulerLevelFor(4)).toBe(LEVEL.PREEMPT);
    expect(schedulerLevelFor(3)).toBe(LEVEL.WAKE);
    expect(schedulerLevelFor(2)).toBe(LEVEL.STATE);
    expect(schedulerLevelFor(1)).toBe(LEVEL.STATE);
  });
});

describe('event shape: delta plus action context, no Live State repeat', () => {
  it('carries key, delta and the action context at fire time', () => {
    const w = createEdgeWatcher();
    const [e] = w.poll({
      entities: [ent(1, 10)],
      currentAction: 'action:collectBlocks',
      goal: 'gather wood',
      position: '10,64,-3',
      dimension: 'overworld',
    });
    expect(e?.type).toBe('entity.hostile_nearby');
    expect(e?.key).toBe(1);
    expect(e?.actionContext).toEqual({
      currentAction: 'action:collectBlocks',
      goal: 'gather wood',
      position: '10,64,-3',
      dimension: 'overworld',
    });
  });
});

describe('shouldEmitHurt', () => {
  it('fires on any decrease with the damage amount, debounced', () => {
    expect(shouldEmitHurt(20, 18, 0, HURT_DEBOUNCE_MS + 1)).toEqual({ fire: true, damage: 2 });
    // 防抖内免发（着火/中毒是持续掉血）。
    expect(shouldEmitHurt(18, 17, 1000, 1000 + HURT_DEBOUNCE_MS - 1).fire).toBe(false);
    // 回血/无变化不发。
    expect(shouldEmitHurt(18, 19, 0, 99999).fire).toBe(false);
    expect(shouldEmitHurt(18, 18, 0, 99999).fire).toBe(false);
    // 读不到不瞎发。
    expect(shouldEmitHurt(null, 18, 0, 99999).fire).toBe(false);
    expect(shouldEmitHurt(20, null, 0, 99999).fire).toBe(false);
  });
});

describe('isStuck', () => {
  it('needs a running action, a fixed position and a full window', () => {
    const now = 100000;
    expect(isStuck('a', 'a', now - STUCK_MS, now, true)).toBe(true);
    expect(isStuck('a', 'a', now - STUCK_MS + 1, now, true)).toBe(false);
    expect(isStuck('a', 'a', now - STUCK_MS, now, false)).toBe(false);
    expect(isStuck('a', 'b', now - STUCK_MS, now, true)).toBe(false);
    expect(isStuck(null, 'b', now - STUCK_MS, now, true)).toBe(false);
  });
});

describe('isHeartbeatDue', () => {
  it('fires once the idle interval passes', () => {
    const now = 1000000;
    expect(isHeartbeatDue(now - HEARTBEAT_MS, now)).toBe(true);
    expect(isHeartbeatDue(now - HEARTBEAT_MS + 1, now)).toBe(false);
  });
});

/**
 * 快照装配：实体级字段以前只声明不填（primed/swelling/hostile/
 * lockedOn/heldWeapon），导致两条 L5 检测器永不触发。这里锁住
 * "装配真的填了"这条契约，并证明检测器从真快照里能点亮。
 */
function fakeBot(entities: Record<string, unknown>): Record<string, unknown> {
  return {
    health: 20,
    food: 20,
    entity: {
      id: 1,
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      metadata: [],
      fallDistance: 0,
    },
    entities,
    inventory: { slots: [], items: () => [] },
    time: { timeOfDay: 0 },
  };
}

describe('lockOnYaw / facingDelta', () => {
  it('returns mineflayer yaw in RADIANS (0 = north/-Z, π/2 = west/-X, π = south/+Z)', () => {
    // 正南：notchian 0 ↔ mineflayer π
    expect(lockOnYaw(0, 0, 0, 10)).toBeCloseTo(Math.PI);
    // 正西：mineflayer π/2
    expect(lockOnYaw(0, 0, -10, 0)).toBeCloseTo(Math.PI / 2);
    // 正北：mineflayer 0
    expect(lockOnYaw(0, 0, 0, -10)).toBeCloseTo(0);
    // 正东：mineflayer 3π/2
    expect(lockOnYaw(0, 0, 10, 0)).toBeCloseTo((3 * Math.PI) / 2);
  });

  it('wraps around the circle in radians', () => {
    expect(facingDelta(Math.PI * 2 - 0.1, 0.1)).toBeCloseTo(0.2);
    expect(facingDelta(0.1, Math.PI * 2 - 0.1)).toBeCloseTo(0.2);
    expect(facingDelta(0, Math.PI)).toBeCloseTo(Math.PI);
  });
});

describe('isWeaponItem', () => {
  it('accepts swords, axes, tridents, bows, crossbows, maces', () => {
    expect(isWeaponItem('diamond_sword')).toBe(true);
    expect(isWeaponItem('netherite_axe')).toBe(true);
    expect(isWeaponItem('trident')).toBe(true);
    expect(isWeaponItem('bow')).toBe(true);
    expect(isWeaponItem('crossbow')).toBe(true);
    expect(isWeaponItem('mace')).toBe(true);
  });

  it('rejects picks, shovels, blocks, food and junk', () => {
    expect(isWeaponItem('diamond_pickaxe')).toBe(false);
    expect(isWeaponItem('iron_shovel')).toBe(false);
    expect(isWeaponItem('oak_planks')).toBe(false);
    expect(isWeaponItem('bread')).toBe(false);
    expect(isWeaponItem(undefined)).toBe(false);
    expect(isWeaponItem(null)).toBe(false);
  });
});

describe('snapshotFromBot entity fields', () => {
  it('marks primed TNT and lights world.tnt.primed_nearby', () => {
    const snap = snapshotFromBot(
      fakeBot({ 5: { id: 5, name: 'tnt', type: 'other', position: { x: 2, y: 64, z: 0 } } }),
    );
    expect(snap.entities?.[0]?.primed).toBe(true);
    expect(snap.entities?.[0]?.distance).toBeCloseTo(2);
    expect(createEdgeWatcher().poll(snap).map((e) => e.type)).toContain('world.tnt.primed_nearby');
  });

  it('reads creeper fuse from metadata[16] and lights world.creeper.swelling', () => {
    const metadata: unknown[] = [];
    metadata[CREEPER_SWELL_DIR_INDEX] = 1;
    const snap = snapshotFromBot(
      fakeBot({
        6: { id: 6, name: 'creeper', type: 'mob', kind: 'Hostile mobs', position: { x: 0, y: 64, z: 2 }, metadata },
      }),
    );
    expect(snap.entities?.[0]?.swelling).toBe(true);
    expect(createEdgeWatcher().poll(snap).map((e) => e.type)).toContain('world.creeper.swelling');
  });

  it('treats a defused creeper (swell_dir -1) as not swelling', () => {
    const metadata: unknown[] = [];
    metadata[CREEPER_SWELL_DIR_INDEX] = -1;
    const snap = snapshotFromBot(
      fakeBot({
        6: { id: 6, name: 'creeper', type: 'mob', kind: 'Hostile mobs', position: { x: 0, y: 64, z: 2 }, metadata },
      }),
    );
    expect(snap.entities?.[0]?.swelling).toBeUndefined();
    expect(createEdgeWatcher().poll(snap).map((e) => e.type)).not.toContain('world.creeper.swelling');
  });

  it('also reads the { value } metadata shape', () => {
    const metadata: unknown[] = [];
    metadata[CREEPER_SWELL_DIR_INDEX] = { value: 1 };
    const snap = snapshotFromBot(
      fakeBot({
        6: { id: 6, name: 'creeper', type: 'mob', kind: 'Hostile mobs', position: { x: 0, y: 64, z: 1 }, metadata },
      }),
    );
    expect(snap.entities?.[0]?.swelling).toBe(true);
  });

  it('treats swell_dir 0 (the ignition tick) as swelling too', () => {
    const metadata: unknown[] = [];
    metadata[CREEPER_SWELL_DIR_INDEX] = 0;
    const snap = snapshotFromBot(
      fakeBot({
        6: { id: 6, name: 'creeper', type: 'mob', kind: 'Hostile mobs', position: { x: 0, y: 64, z: 2 }, metadata },
      }),
    );
    expect(snap.entities?.[0]?.swelling).toBe(true);
  });

  it('covers hostile mobs via the mcData category, not just the name list', () => {
    const snap = snapshotFromBot(
      fakeBot({ 7: { id: 7, name: 'creaking', type: 'mob', kind: 'Hostile mobs', position: { x: 0, y: 64, z: 4 } } }),
    );
    expect(snap.entities?.[0]?.hostile).toBe(true);
    expect(createEdgeWatcher().poll(snap).map((e) => e.type)).toContain('entity.hostile_nearby');
  });

  it('marks a player holding a weapon and one facing the bot', () => {
    const snap = snapshotFromBot(
      fakeBot({
        8: {
          id: 8,
          name: 'Steve',
          type: 'player',
          // 实体在 bot 南边（z=+3），所以"看向 bot"= 朝北 = mineflayer yaw 0。
          position: { x: 0, y: 64, z: 3 },
          yaw: 0,
          heldItem: { name: 'diamond_sword' },
        },
      }),
    );
    // 玩家的手持物在实体上（mineflayer: entity.heldItem = equipment[0]）。
    expect(snap.entities?.[0]?.isPlayer).toBe(true);
    expect(snap.entities?.[0]?.heldWeapon).toBe(true);
    expect(snap.entities?.[0]?.lockedOn).toBe(true);
  });

  it('leaves heldWeapon unset for a player holding a pickaxe', () => {
    const snap = snapshotFromBot(
      fakeBot({
        8: { id: 8, name: 'Steve', type: 'player', position: { x: 0, y: 64, z: 3 }, heldItem: { name: 'iron_pickaxe' } },
      }),
    );
    expect(snap.entities?.[0]?.heldWeapon).toBeUndefined();
    expect(snap.entities?.[0]?.hostile).toBeUndefined();
  });

  it('does not mark a player facing away as locked on', () => {
    const snap = snapshotFromBot(
      fakeBot({ 8: { id: 8, name: 'Steve', type: 'player', position: { x: 0, y: 64, z: 3 }, yaw: Math.PI } }),
    );
    expect(snap.entities?.[0]?.lockedOn).toBeUndefined();
  });

  /**
   * 回归线：entity.yaw 是 mineflayer 的**弧度**（0=北）。之前拿它当 notchian
   * 角度（度）比，判定退化成"bot 是否在该实体正南 ±36°"，与朝向无关——
   * 只测北边一个方向的用例抓不到，所以这里四个方位都钉住。
   */
  it.each([
    ['from the north', 0, 3, 0],
    ['from the south', 0, -3, Math.PI],
    ['from the east', -3, 0, (3 * Math.PI) / 2],
    ['from the west', 3, 0, Math.PI / 2],
  ])('lockedOn is true when an entity %s faces the bot', (_label, ex, ez, facing) => {
    const snap = snapshotFromBot(
      fakeBot({ 8: { id: 8, name: 'Steve', type: 'player', position: { x: ex, y: 64, z: ez }, yaw: facing } }),
    );
    expect(snap.entities?.[0]?.lockedOn).toBe(true);
  });

  it('lockedOn is false when an entity in the same spot faces 90° away', () => {
    const snap = snapshotFromBot(
      fakeBot({ 8: { id: 8, name: 'Steve', type: 'player', position: { x: 0, y: 64, z: 3 }, yaw: Math.PI / 2 } }),
    );
    expect(snap.entities?.[0]?.lockedOn).toBeUndefined();
  });

  it('feeds the resolvePriority upgrade now that lockedOn is populated', () => {
    const snapshot = {
      health: 5,
      entities: [{ id: 9, name: 'zombie', distance: 5, lockedOn: true }],
    };
    expect(resolvePriority({ type: 'entity.hostile_nearby', level: 3, key: 9 }, snapshot)).toBe(4);
  });

  it('never treats a PLAYER named creeper/tnt as a mob (L5 false positive)', () => {
    // 玩家实体的 metadata[16] 是 `score`（默认 0），不是 `swell_dir`；而实体名
    // 现在优先取 username，所以用户名恰好叫 creeper/tnt 的玩家会被判据命中，
    // 直接触发 L5 EMERGENCY（停掉全部动作 + 进 emergency）。公开服上
    // `creeper` 是常见用户名，所以两处都必须有 !isPlayer 守卫。
    const metadata: unknown[] = [];
    metadata[CREEPER_SWELL_DIR_INDEX] = 0; // 玩家的 score，默认值
    const creeperNamed = snapshotFromBot(
      fakeBot({
        8: { id: 8, type: 'player', name: 'player', username: 'creeper', position: { x: 0, y: 64, z: 2 }, metadata },
      }),
    );
    expect(creeperNamed.entities?.[0]?.name).toBe('creeper');
    expect(creeperNamed.entities?.[0]?.swelling).toBeUndefined();
    expect(creeperNamed.entities?.[0]?.primed).toBeUndefined();
    const types = createEdgeWatcher().poll(creeperNamed).map((e) => e.type);
    expect(types).not.toContain('world.creeper.swelling');

    const tntNamed = snapshotFromBot(
      fakeBot({ 9: { id: 9, type: 'player', name: 'player', username: 'tnt', position: { x: 0, y: 64, z: 2 } } }),
    );
    expect(tntNamed.entities?.[0]?.primed).toBeUndefined();
    expect(createEdgeWatcher().poll(tntNamed).map((e) => e.type)).not.toContain('world.tnt.primed_nearby');
  });

  it('survives a bot with no entities table', () => {
    expect(snapshotFromBot({ health: 20 }).entities).toBeUndefined();
    expect(snapshotFromBot(null).entities).toBeUndefined();
  });
});
