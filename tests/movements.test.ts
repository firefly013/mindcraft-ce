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
import { MAX_DROP_DOWN, applyWaterPolicy, deepWaterAllowed, movementsFor, waterBlockId } from '../src/body/safety/movements.js';

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
      .filter((f) => !f.endsWith(join('body', 'safety', 'movements.ts')))
      .filter((f) => BARE_MOVEMENTS.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f).replace(/\\/g, '/'));
    // 报错信息要能直接照着改：指出该用什么替代。
    expect(
      offenders,
      `这些文件直接 new 了 Movements，会绕过安全基线（落差/冲刺/跑酷/深水）。改用 movementsFor(bot)。`,
    ).toEqual([]);
  });

  it('movements.ts 自己确实还留着那一处构造（守卫没写成空判据）', () => {
    const self = join(SRC, 'body', 'safety', 'movements.ts');
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

describe('搭塔的垫脚方块来自背包（用户 2026-10-18："默认应该允许搭才合理"）', () => {
  it('拿着下界岩/深板岩也能搭：库默认只认 dirt + cobblestone', () => {
    const registry: any = minecraftData(MC_VERSION);
    // 库的出厂值就那两种（movements.js:90-92）——先确认这个前提没变。
    const bare = movementsFor({ registry, version: MC_VERSION });
    expect(bare.allow1by1towers).toBe(true); // 开关本来就是开的

    const bot = {
      registry,
      version: MC_VERSION,
      inventory: {
        items: () => [
          { name: 'netherrack' },
          { name: 'cobbled_deepslate' },
          { name: 'torch' },   // 放不成整块
          { name: 'coal' },    // 根本不是方块
        ],
      },
    };
    const m = movementsFor(bot);
    expect(m.allow1by1towers).toBe(true);
    // ⚠️ 垫脚表里必须是**物品 id**（pathfinder 拿 item.type 比），不是方块 id：
    // 下界岩 方块 id 255 / 物品 id 324，填错了等于一条都匹配不上。
    expect(m.scafoldingBlocks).toContain(registry.itemsByName.netherrack.id);
    expect(m.scafoldingBlocks).toContain(registry.itemsByName.cobbled_deepslate.id);
    expect(m.scafoldingBlocks).not.toContain(registry.blocksByName.netherrack.id);
    // 库自己的默认值（dirt/cobblestone 的物品 id）也还在。
    expect(m.scafoldingBlocks).toContain(registry.itemsByName.dirt.id);
    // 放不成整块的（火把）不能当垫脚
    expect(m.scafoldingBlocks).not.toContain(registry.itemsByName.torch.id);
    // 每个垫脚 id 都必须对应一个"能整块放下"的方块
    const fullBlockItemIds = new Set(
      Object.values(registry.blocksByName as Record<string, { id: number; boundingBox?: string }>)
        .filter((b) => b.boundingBox === 'block')
        .map((b) => registry.itemsByName[Object.keys(registry.blocksByName).find((n) => registry.blocksByName[n].id === b.id) as string]?.id)
        .filter((id): id is number => typeof id === 'number'),
    );
    for (const id of m.scafoldingBlocks) {
      expect(fullBlockItemIds.has(id), `垫脚 id ${id} 必须是能整块放下的方块物品`).toBe(true);
    }
  });

  it('背包读不到也不崩（沿用库的默认垫脚方块）', () => {
    const registry: any = minecraftData(MC_VERSION);
    expect(() => movementsFor({ registry, version: MC_VERSION })).not.toThrow();
  });

  it('徒手软方块在寻路里算得出代价（不会因为"没工具"被当成走不通）', () => {
    const registry: any = minecraftData(MC_VERSION);
    const bot: any = {
      registry,
      version: MC_VERSION,
      inventory: { items: () => [] },   // 空手
      entity: { effects: {}, position: { x: 0, y: 64, z: 0 } },
      blockAt: () => null,
      pathfinder: { bestHarvestTool: () => null },
    };
    const m = movementsFor(bot);
    expect(m.canDig).toBe(true);
    // 下界岩：徒手 digTime 2 秒（真值，node 里核过），代价必须是**有限值**。
    const netherrack = {
      name: 'netherrack',
      type: registry.blocksByName.netherrack.id,
      position: { x: 0, y: 64, z: 1 },
      safe: false,
      physical: true,
      openable: false,
      digTime: (tool: unknown) => (tool == null ? 2000 : 400),
    };
    const toBreak: unknown[] = [];
    const cost = m.safeOrBreak(netherrack, toBreak);
    expect(Number.isFinite(cost)).toBe(true);
    expect(toBreak).toHaveLength(1);   // 记进了"要挖的方块"，说明这条路真的会挖
  });
});
