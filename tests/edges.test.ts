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
  isHeartbeatDue,
  isStuck,
  resolvePriority,
  schedulerLevelFor,
  shouldEmitHurt,
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
