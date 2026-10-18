/**
 * 用户报的那条（2026-10-18）："这个寻路器经常失败，不是找不到可行路径，就是提示
 * 什么路径太长之类的，总是失败。"
 *
 * 日志侧同一晚：`Took to long to decide path to goal!` ×70、`NoPath` ×29、
 * `Path was stopped before it could be completed` ×21。根因不是"没路"，是
 * **把上百格的目标一次性丢给 A***，加上无界搜索（searchRadius 默认 -1）。
 *
 * 这里锁住四件事：
 *   1. 长目标必须**分段**（每段 ≤32 格），每段一次 A* —— 不是一次算完；
 *   2. 每段失败要按**阶梯**加码（延长算路 → 搭塔 → 放开挖 → 横向偏移），
 *      第一档成功就停；
 *   3. 失败回执要能分出四类原因（探测/A* 超时/落差限制/挖不动），
 *      每类带一句具体的下一步；
 *   4. 落差限制不许被默默放宽（只在血多 + 脚下无岩浆时 +1 格）。
 */
import { describe, expect, it, vi } from 'vitest';
import minecraftData from 'minecraft-data';
import {
  PATH_CHUNK_LENGTH,
  PATH_CHUNK_THRESHOLD,
  PATH_LEG_LADDER,
  PATH_SEARCH_RADIUS,
  canRelaxDropDown,
  classifyPathFailure,
  findDropAhead,
  goToPosition,
  hasDigTool,
  lateralOffsetWaypoint,
  planPathLegs,
} from '../src/body/library/skills.js';

const MC_VERSION = '1.20.4';

describe('分段：长目标拆成有界的腿（纯函数）', () => {
  it('短距离不分段：一段直达', () => {
    expect(planPathLegs({ x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 20 })).toEqual([{ x: 20, y: 64, z: 20 }]);
    // 阈值本身不分段（≤ threshold）。
    expect(
      planPathLegs({ x: 0, y: 64, z: 0 }, { x: PATH_CHUNK_THRESHOLD, y: 64, z: 0 }),
    ).toHaveLength(1);
  });

  it('长距离分段：每段 ≤ PATH_CHUNK_LENGTH，最后一段精确落在目标上', () => {
    const legs = planPathLegs({ x: 0, y: 64, z: 0 }, { x: 130, y: 70, z: 0 });
    // 130 格 → ceil(130/32) = 5 段。
    expect(legs).toHaveLength(5);
    let prev = { x: 0, y: 64, z: 0 };
    for (const leg of legs) {
      expect(Math.hypot(leg.x - prev.x, leg.z - prev.z)).toBeLessThanOrEqual(PATH_CHUNK_LENGTH + 1e-6);
      prev = leg;
    }
    expect(legs[legs.length - 1]).toEqual({ x: 130, y: 70, z: 0 });
    // 高度按比例插值，不是每段都跳到底/跳到顶。
    expect(legs[0].y).toBeGreaterThan(64);
    expect(legs[0].y).toBeLessThan(70);
  });

  it('斜着走也是按水平距离分段（不是按坐标轴）', () => {
    const legs = planPathLegs({ x: 0, y: 64, z: 0 }, { x: 60, y: 64, z: 80 });
    expect(legs).toHaveLength(Math.ceil(100 / PATH_CHUNK_LENGTH));
  });
});

describe('横向偏移航点（纯函数）', () => {
  it('垂直于目标方向，左右各偏 3 格，且不改变高度', () => {
    const from = { x: 0, y: 64, z: 0 };
    const to = { x: 10, y: 64, z: 0 };
    const right = lateralOffsetWaypoint(from, to, 1);
    const left = lateralOffsetWaypoint(from, to, -1);
    expect(Math.hypot(right.x - to.x, right.z - to.z)).toBeCloseTo(3, 5);
    expect(Math.hypot(left.x - to.x, left.z - to.z)).toBeCloseTo(3, 5);
    expect(right.z).toBeCloseTo(3, 5);
    expect(left.z).toBeCloseTo(-3, 5);
    expect(right.y).toBe(64);
  });

  it('起点和目标重合时不乱偏（原样返回）', () => {
    expect(lateralOffsetWaypoint({ x: 5, y: 1, z: 5 }, { x: 5, y: 1, z: 5 }, 1)).toEqual({ x: 5, y: 1, z: 5 });
  });
});

describe('重试阶梯：顺序即加码顺序', () => {
  it('六档：基准 → 延长算路 → 搭塔 → 放开挖 → 左偏 → 右偏', () => {
    expect(PATH_LEG_LADDER.map((s) => s.attempt)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(PATH_LEG_LADDER.map((s) => s.side)).toEqual([0, 0, 0, 0, 1, -1]);
    // 每档都要有一句人话（回执直接用）。
    for (const step of PATH_LEG_LADDER) expect(step.what.length).toBeGreaterThan(2);
    // attempt 单调不减：档位只往上加，不许回退。
    const attempts = PATH_LEG_LADDER.map((s) => s.attempt);
    expect([...attempts].sort((a, b) => a - b)).toEqual(attempts);
  });
});

describe('失败分类：四类原因 + 每类一句下一步', () => {
  it('A* 算路超时', () => {
    const d = classifyPathFailure({ message: 'Took to long to decide path to goal!' });
    expect(d.kind).toBe('timeout');
    expect(d.reason).toContain('算路超时');
    expect(d.next).toContain('32 格');
  });

  it('落差限制（MAX_DROP_DOWN）', () => {
    const d = classifyPathFailure({ message: 'No path to the goal!', dropAhead: 4 });
    expect(d.kind).toBe('drop');
    expect(d.reason).toContain('落差限制');
    expect(d.reason).toContain('4 格');
    expect(d.next).toContain('侧面');
  });

  it('没工具挖不开', () => {
    const d = classifyPathFailure({ message: 'No path to the goal!', noTool: true });
    expect(d.kind).toBe('nodig');
    expect(d.next).toContain('镐');
  });

  it('快速探测没算出（不代表走不到）', () => {
    const d = classifyPathFailure({ probeFailed: true });
    expect(d.kind).toBe('probe');
    expect(d.reason).toContain('不代表走不到');
  });

  it('纯 NoPath：也给可执行的下一步，不空手', () => {
    const d = classifyPathFailure({ message: 'No path to the goal!' });
    expect(d.kind).toBe('unknown');
    expect(d.next.length).toBeGreaterThan(5);
  });

  it('没有错误信息也不说谎（不编造原因）', () => {
    const d = classifyPathFailure({});
    expect(d.kind).toBe('unknown');
    expect(d.reason).toContain('没有具体错误信息');
  });
});

describe('前方落差探测（诊断用）', () => {
  it('前方 4 格落差 → 报 4；2 格以内 → 不算', () => {
    const at = (x: number, y: number): { name: string } =>
      y === 60 && x === 2 ? { name: 'stone' } : { name: 'air' };
    // 站在 y=64，脚下前方第 2 列的地面在 y=60 → 落差 4。
    expect(findDropAhead((x, y) => at(x, y), { x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 })).toBe(4);

    const near = (x: number, y: number): { name: string } =>
      y === 62 && x === 1 ? { name: 'stone' } : { name: 'air' };
    expect(findDropAhead((x, y) => near(x, y), { x: 0, y: 64, z: 0 }, { x: 5, y: 64, z: 0 })).toBeNull();
  });

  it('读方块抛异常也不崩（退回 null）', () => {
    expect(
      findDropAhead(
        () => {
          throw new Error('no world');
        },
        { x: 0, y: 64, z: 0 },
        { x: 5, y: 64, z: 0 },
      ),
    ).toBeNull();
  });
});

describe('落差放宽：必须条件成立才允许', () => {
  it('血少 → 不放宽', () => {
    expect(canRelaxDropDown({ health: 8, entity: { position: { x: 0, y: 64, z: 0 } }, blockAt: () => ({ name: 'air' }) })).toBe(false);
  });

  it('脚下 4 格内有岩浆 → 不放宽', () => {
    const bot = {
      health: 20,
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: (p: any) => (p.y === 61 ? { name: 'lava' } : { name: 'air' }),
    };
    expect(canRelaxDropDown(bot)).toBe(false);
  });

  it('血够 + 无岩浆 → 放宽', () => {
    const bot = {
      health: 20,
      entity: { position: { x: 0, y: 64, z: 0 } },
      blockAt: () => ({ name: 'netherrack' }),
    };
    expect(canRelaxDropDown(bot)).toBe(true);
  });
});

describe('工具诊断', () => {
  it('背包里有镐/斧/锹/锄才算有挖的工具', () => {
    expect(hasDigTool({ inventory: { items: () => [{ name: 'netherrack' }, { name: 'coal' }] } })).toBe(false);
    expect(hasDigTool({ inventory: { items: () => [{ name: 'stone_pickaxe' }] } })).toBe(true);
    expect(hasDigTool({ inventory: { items: () => { throw new Error('x'); } } })).toBe(false);
  });
});

/** 一个够 goToPosition 走完全程的假 bot：goto 会真的把位置挪到目标上。 */
function fakePathBot(registry: any, start = { x: 0, y: 64, z: 0 }, gotoImpl?: (goal: any, n: number) => Promise<void>) {
  const pos = { ...start };
  const calls: Array<{ x: number; y: number; z: number }> = [];
  const bot: any = {
    output: '',
    interrupt_code: false,
    health: 20,
    registry,
    version: MC_VERSION,
    physicsEnabled: true,
    inventory: { items: () => [] },
    entity: {
      effects: {},
      position: {
        get x() {
          return pos.x;
        },
        get y() {
          return pos.y;
        },
        get z() {
          return pos.z;
        },
        clone: () => ({ x: pos.x, y: pos.y, z: pos.z, offset: (dx: number, dy: number, dz: number) => ({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }) }),
        offset: (dx: number, dy: number, dz: number) => ({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }),
        distanceTo: (p: any) => Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z),
      },
    },
    blockAt: () => ({ name: 'air' }),
    chat: () => {},
    stopDigging: () => {},
    pathfinder: {
      thinkTimeout: 0,
      tickTimeout: 0,
      searchRadius: -1,
      setMovements: vi.fn(),
      getPathTo: vi.fn(() => ({ status: 'success' })),
      goto: vi.fn(async (goal: any) => {
        calls.push({ x: goal.x, y: goal.y, z: goal.z });
        if (gotoImpl != null) {
          await gotoImpl(goal, calls.length);
          return;
        }
        pos.x = goal.x;
        pos.y = goal.y;
        pos.z = goal.z;
      }),
      stop: vi.fn(),
    },
    _calls: calls,
    _pos: pos,
  };
  return bot;
}

describe('goToPosition：长目标真的分段走（每段一次 A*）', () => {
  it('130 格 → 5 次 goto，每次 ≤32 格，最后一次是目标，回执说明分段', async () => {
    const registry: any = minecraftData(MC_VERSION);
    const bot = fakePathBot(registry);
    const ok = await goToPosition(bot, 130, 64, 0, 2);
    expect(ok, bot.output).toBe(true);
    expect(bot._calls).toHaveLength(5);
    let prev = { x: 0, z: 0 };
    for (const call of bot._calls) {
      expect(Math.hypot(call.x - prev.x, call.z - prev.z)).toBeLessThanOrEqual(PATH_CHUNK_LENGTH + 1e-6);
      prev = { x: call.x, z: call.z };
    }
    expect(bot._calls[4]).toMatchObject({ x: 130, z: 0 });
    expect(bot.output).toContain('分 5 段走');
    expect(bot.output).toContain('还剩约');
  });

  it('短目标不分段：一次 goto 直达', async () => {
    const registry: any = minecraftData(MC_VERSION);
    const bot = fakePathBot(registry);
    await expect(goToPosition(bot, 20, 64, 0, 2)).resolves.toBe(true);
    expect(bot._calls).toHaveLength(1);
    expect(bot._calls[0]).toMatchObject({ x: 20, z: 0 });
    expect(bot.output).not.toContain('分 1 段走');
  });

  it('搜索半径被设成有界值（默认 -1 无界就是烧光预算的根因）', async () => {
    const registry: any = minecraftData(MC_VERSION);
    const bot = fakePathBot(registry);
    await goToPosition(bot, 20, 64, 0, 2);
    expect(bot.pathfinder.searchRadius).toBe(PATH_SEARCH_RADIUS);
    expect(PATH_SEARCH_RADIUS).toBeGreaterThan(0);
  });

  it('第一档失败 → 第二档（延长算路）成功，不会原样重试', async () => {
    const registry: any = minecraftData(MC_VERSION);
    const bot = fakePathBot(registry, { x: 0, y: 64, z: 0 }, async (_goal, n) => {
      if (n === 1) throw new Error('Took to long to decide path to goal!');
      bot._pos.x = _goal.x;
      bot._pos.z = _goal.z;
    });
    await expect(goToPosition(bot, 20, 64, 0, 2)).resolves.toBe(true);
    expect(bot._calls).toHaveLength(2);
    expect(bot.output).toContain('换下一档');
    expect(bot.output).toContain('延长算路到 30 秒');
  });

  it('中途被打断：不再往下试，如实报中断', async () => {
    const registry: any = minecraftData(MC_VERSION);
    const bot = fakePathBot(registry, { x: 0, y: 64, z: 0 }, async () => {
      bot.interrupt_code = true;
      throw new Error('Took to long to decide path to goal!');
    });
    await expect(goToPosition(bot, 20, 64, 0, 2)).resolves.toBe(false);
    expect(bot._calls).toHaveLength(1);
    expect(bot.output).toContain('中断');
  });
});
