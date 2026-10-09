/**
 * 寻路配置的契约。
 *
 * 这里最重要的一条不是某个函数对不对，而是**架构守卫**：不许再有第二处
 * `new Movements(bot)`。
 *
 * 为什么值得用测试挡：这个仓库曾经有 18 处 `new Movements`，安全配置只写在
 * 其中 1 处。追怪、逃跑、保命 fleeTo 全都从水里直穿过去，而代码看起来"闸门是
 * 有的"。这种洞**读代码发现不了**——每处 `new Movements(bot)` 单看都人畜无害，
 * 只有数一遍才知道漏了 16 处。所以交给机器数。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import { MAX_DROP_DOWN, applyWaterPolicy, deepWaterAllowed, movementsFor, waterBlockId } from '../src/agent/movements.js';

const SRC = join(process.cwd(), 'src');
const MC_VERSION = '1.20.4';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 裸构造：new Movements( / new pf.Movements( / new (pf as any).Movements( */
const BARE_MOVEMENTS = /new\s+(?:\([^)]*as\s+any\)\s*\.\s*|[A-Za-z_$][\w$]*\s*\.\s*)?Movements\s*\(/;

describe('架构守卫：Movements 只有一个来源', () => {
  it('除了 movements.ts，任何地方都不许直接 new Movements', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => !f.endsWith(join('agent', 'movements.ts')))
      .filter((f) => BARE_MOVEMENTS.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f).replace(/\\/g, '/'));
    // 报错信息要能直接照着改：指出该用什么替代。
    expect(
      offenders,
      `这些文件直接 new 了 Movements，会绕过安全基线（落差/冲刺/跑酷/深水）。改用 movementsFor(bot)。`,
    ).toEqual([]);
  });

  it('movements.ts 自己确实还留着那一处构造（守卫没写成空判据）', () => {
    const self = join(SRC, 'agent', 'movements.ts');
    expect(BARE_MOVEMENTS.test(readFileSync(self, 'utf8'))).toBe(true);
  });
});

describe('applyWaterPolicy', () => {
  function fakeMovements(): { blocksToAvoid: Set<number> } {
    return { blocksToAvoid: new Set<number>() };
  }

  it('未授权 → 把水塞进 blocksToAvoid（寻路绕开水）', () => {
    const m = fakeMovements();
    applyWaterPolicy(m, false, 9);
    expect(m.blocksToAvoid.has(9)).toBe(true);
  });

  it('授权了 → 把水从 blocksToAvoid 摘掉（水下作业要能算出水里的路）', () => {
    const m = fakeMovements();
    m.blocksToAvoid.add(9);
    applyWaterPolicy(m, true, 9);
    expect(m.blocksToAvoid.has(9)).toBe(false);
  });

  it('拿不到水的 id → 什么都不做（不抛，也不假装拦住了）', () => {
    const m = fakeMovements();
    expect(() => applyWaterPolicy(m, false, null)).not.toThrow();
    expect(m.blocksToAvoid.size).toBe(0);
  });

  it('movements 形状不对 → 不抛', () => {
    expect(() => applyWaterPolicy(null, false, 9)).not.toThrow();
    expect(() => applyWaterPolicy({}, false, 9)).not.toThrow();
    expect(() => applyWaterPolicy({ blocksToAvoid: 'nope' }, false, 9)).not.toThrow();
  });
});

describe('waterBlockId', () => {
  it('优先从 bot 自己的 registry 拿（和 pathfinder 造 Movements 时同一套）', () => {
    expect(waterBlockId({ registry: { blocksByName: { water: { id: 34 } } } })).toBe(34);
  });

  it('registry 没有就退回 mcdata；mcdata 还没初始化也不许崩', () => {
    // 没连服务器时 mcdata 是 null，getBlockId 内部 `mcdata.blocksByName` 会抛
    // TypeError。工厂被 18 个调用点共用，在这里抛一次等于全 bot 瘫痪。
    expect(() => waterBlockId(null)).not.toThrow();
    expect(() => waterBlockId({})).not.toThrow();
    expect(() => waterBlockId({ registry: {} })).not.toThrow();
  });

  it('registry 里水不是数字 id 就当没有', () => {
    expect(waterBlockId({ registry: { blocksByName: { water: { id: 'x' } } } })).toBeNull();
  });
});

describe('deepWaterAllowed', () => {
  it('没授权就是不允许（默认禁止）', () => {
    expect(deepWaterAllowed(null)).toBe(false);
  });
});

describe('movementsFor', () => {
  it('出厂就带安全基线：落差/冲刺/跑酷/深水全收住了', () => {
    // Movements 的构造函数要读一整张方块表（chest/fire/lava/water…），假 registry
    // 补不全，直接用真数据。
    const registry: any = minecraftData(MC_VERSION);
    const m = movementsFor({ registry, version: MC_VERSION });
    const waterId: number = registry.blocksByName.water.id;

    expect(m.maxDropDown).toBe(MAX_DROP_DOWN);
    expect(m.allowSprinting).toBe(false);
    expect(m.allowParkour).toBe(false);
    // 未授权 → 水进了避让集合（这才是"不许穿过水"真正生效的地方）
    expect(m.blocksToAvoid.has(waterId)).toBe(true);
  });

  it('默认（未授权）造出来的两套 Movements 是同一套安全基线', () => {
    // goToGoal 会造"非破坏性/破坏性"两套，两者都必须带闸门——以前只有一套有。
    const registry: any = minecraftData(MC_VERSION);
    const waterId: number = registry.blocksByName.water.id;
    for (const m of [movementsFor({ registry, version: MC_VERSION }), movementsFor({ registry, version: MC_VERSION })]) {
      expect(m.blocksToAvoid.has(waterId)).toBe(true);
    }
  });
});
