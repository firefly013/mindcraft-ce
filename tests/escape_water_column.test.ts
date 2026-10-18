/**
 * escapeWater 的真机地形回归（用户/Lead 解码存档给出的逐格表）。
 *
 * A. 垂直水柱（overnight_a 21:44，(3.7,62.46,29.3)，血 20→16.17）：x=2..3 z=29 的
 *    水从 y=58 到 y=62，x=1/x=4 的墙 y=58..61 是沙/土，**同层一步外 (4,62,29) 是草地**。
 *    机制是**溺水**（水往下流，上浮顶不住），不是摔死。
 * B. 1×1 水坑 + 四面实心墙（overnight_b 21:37）：得**挖出台阶**才能出来。
 * C. 水柱 + 往下流 + 没有任何出口：回执必须点明"水流把你按下去"，并给出
 *    keepInventory 世界里的**主动溺水**这个真选项（含代价）。
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import {
  deliberateDrownAdvice,
  escapeWaterSkill,
  findStepOutSpot,
  inDownwardCurrent,
  planEscapeDig,
} from '../src/body/library/survival.js';

const MC_VERSION = '1.20.4';
const registry: any = minecraftData(MC_VERSION);
const WATER_ID = registry.blocksByName.water.id as number;

type Cells = Map<string, string>;
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** 造一个假 bot：地形用 cells 表，position 可被 goTo/控制键改写。 */
function columnBot(cells: Cells, at: { x: number; y: number; z: number }, opts: { flowingLevel?: number } = {}): any {
  const pos = new Vec3(at.x, at.y, at.z);
  const controls: Record<string, boolean> = {};
  const blockAt = (p: any): any => {
    const x = Math.floor(Number(p?.x));
    const y = Math.floor(Number(p?.y));
    const z = Math.floor(Number(p?.z));
    const name = cells.get(key(x, y, z)) ?? 'air';
    const def = registry.blocksByName[name];
    const block: any = { name, type: typeof def?.id === 'number' ? def.id : 0, position: p };
    if ((name === 'water' || name === 'flowing_water') && opts.flowingLevel != null) {
      block.getProperties = () => ({ level: String(opts.flowingLevel) });
      block._properties = { level: String(opts.flowingLevel) };
    }
    return block;
  };
  return {
    entity: { position: pos },
    blockAt,
    registry,
    version: MC_VERSION,
    interrupt_code: false,
    output: '',
    inventory: { items: () => [] },
    setControlState: (k: string, v: boolean) => {
      controls[k] = v;
    },
    lookAt: async () => undefined,
    _pos: pos,
    _controls: controls,
  };
}

function noopToolDeps(overrides: Record<string, unknown> = {}): any {
  let clock = 0;
  return {
    sleep: async () => undefined,
    now: () => (clock += 1000),
    maxMs: 2000,
    mineUp: async () => false,
    digBlock: async () => false,
    canDig: () => false,
    keepInventory: true,
    ...overrides,
  };
}

/** A：垂直水柱 + 同层一步外的草地。 */
function columnCells(): Cells {
  const cells: Cells = new Map();
  for (let x = 0; x <= 5; x++) {
    for (let z = 27; z <= 31; z++) {
      for (let y = 54; y <= 72; y++) cells.set(key(x, y, z), 'air');
      for (let y = 54; y <= 57; y++) cells.set(key(x, y, z), 'sand'); // 底
    }
  }
  for (let y = 58; y <= 62; y++) {
    cells.set(key(2, y, 29), 'water');
    cells.set(key(3, y, 29), 'water');
  }
  for (let y = 58; y <= 61; y++) {
    cells.set(key(1, y, 29), 'sand');
    cells.set(key(4, y, 29), 'sand');
  }
  cells.set(key(4, 62, 29), 'grass_block'); // 同层一步外的干岸
  return cells;
}

/** B：1×1 水坑 + 四面实心墙（Lead 给的逐格表，用真实方块名）。 */
function pitCells(): Cells {
  const cells: Cells = new Map();
  const set = (x: number, y: number, z: number, name: string): void => {
    cells.set(key(x, y, z), name);
  };
  for (let x = -3; x <= 2; x++) {
    for (let y = 54; y <= 66; y++) set(x, y, 25, 'air');
    set(x, 58, 25, 'dirt');
  }
  // y=59
  set(-3, 59, 25, 'dirt');
  set(-2, 59, 25, 'dirt');
  set(-1, 59, 25, 'grass_block');
  set(0, 59, 25, 'dirt');
  set(1, 59, 25, 'dirt');
  set(2, 59, 25, 'dirt');
  // y=60（bot 站的那格是水）
  set(-3, 60, 25, 'dirt');
  set(-2, 60, 25, 'dirt');
  set(-1, 60, 25, 'water');
  set(0, 60, 25, 'dirt');
  set(1, 60, 25, 'grass_block');
  set(2, 60, 25, 'dirt');
  // y=61
  set(-3, 61, 25, 'cobblestone');
  set(-2, 61, 25, 'dirt');
  set(-1, 61, 25, 'air');
  set(0, 61, 25, 'dirt');
  set(1, 61, 25, 'air');
  set(2, 61, 25, 'dirt');
  // y=62
  set(-3, 62, 25, 'air');
  set(-2, 62, 25, 'grass_block');
  set(-1, 62, 25, 'air');
  set(0, 62, 25, 'grass_block');
  set(1, 62, 25, 'air');
  set(2, 62, 25, 'dirt');
  // y=63
  set(-3, 63, 25, 'red_bed');
  set(-2, 63, 25, 'red_bed');
  set(-1, 63, 25, 'air');
  set(0, 63, 25, 'sugar_cane');
  set(1, 63, 25, 'air');
  set(2, 63, 25, 'grass_block');
  return cells;
}

describe('A. 垂直水柱：先横向一步上岸（真机 21:44 overnight_a）', () => {
  it('findStepOutSpot 找到同层一步外的草地', () => {
    const bot = columnBot(columnCells(), { x: 3.7, y: 62.46, z: 29.3 });
    const spot = findStepOutSpot(bot, 2);
    expect(spot).toMatchObject({ x: 4, y: 63, z: 29 }); // 站在 (4,62,29) 草地上面
  });

  it('escapeWater 横向走到草地上，并说清楚"没往上爬"', async () => {
    const bot = columnBot(columnCells(), { x: 3.7, y: 62.46, z: 29.3 });
    const goTo = async (b: any, x: number, y: number, z: number): Promise<boolean> => {
      if (x === 4 && y === 63 && z === 29) {
        b._pos.x = 4.5;
        b._pos.y = 63;
        b._pos.z = 29.5;
        return true;
      }
      return false;
    };
    const text = await escapeWaterSkill(bot, noopToolDeps({ goTo }));
    expect(text).toContain('已真正脱险');
    expect(text).toContain('横向一步上岸');
    expect(text).toContain('(4,62,29)'); // 点名的就是那块草地
    expect(bot._pos.y).toBe(63); // 真的上去了
  });
});

describe('B. 1×1 水坑：挖出台阶出来（真机 21:37 overnight_b）', () => {
  it('同层/上一格有干岸但走不过去 → 挖开墙、站上台阶', async () => {
    const cells = pitCells();
    const bot = columnBot(cells, { x: -0.3, y: 60, z: 25.3 });
    const dug: string[] = [];
    const dig = async (_b: any, x: number, y: number, z: number): Promise<boolean> => {
      dug.push(key(x, y, z));
      const name = cells.get(key(x, y, z));
      if (name == null || name === 'water' || name === 'air') return false;
      cells.set(key(x, y, z), 'air');
      return true;
    };
    const goTo = async (b: any, x: number, y: number, z: number): Promise<boolean> => {
      // 只有挖开后的台阶能走进去；别的干岸一律"走不通"。
      if (x === 0 && y === 61 && z === 25) {
        b._pos.x = 0.5;
        b._pos.y = 61;
        b._pos.z = 25.5;
        return true;
      }
      return false;
    };
    const text = await escapeWaterSkill(
      bot,
      noopToolDeps({ goTo, digBlock: dig, canDig: (_b: any, name: string) => name === 'dirt' || name === 'grass_block' }),
    );
    expect(text).toContain('已真正脱险');
    expect(text).toContain('挖出台阶');
    expect(dug.length).toBeGreaterThan(0);
    expect(text).toContain('(0,61,25)');
    expect(bot._pos.y).toBe(61);
  });

  it('planEscapeDig：从坑底看，东面是"挖头上两格 → 跳上台阶"', () => {
    const cells = pitCells();
    const blockAt = (x: number, y: number, z: number): string | null => cells.get(key(x, y, z)) ?? 'air';
    const plan = planEscapeDig(blockAt, { x: -1, y: 60, z: 25 }, (name) => name === 'dirt' || name === 'grass_block');
    expect(plan).toMatchObject({ kind: 'step-up', direction: 'east', stand: { x: 0, y: 61, z: 25 } });
    expect(plan?.dig.length).toBe(2);
  });

  it('墙挖不动（没镐）→ 如实说"挖不动"并给 mineBlock 的下一步，不假报脱险', async () => {
    const bot = columnBot(pitCells(), { x: -0.3, y: 60, z: 25.3 });
    const text = await escapeWaterSkill(bot, noopToolDeps({ goTo: async () => false }));
    expect(text).toContain('没能脱险');
    expect(text).toContain('挖不动');
    expect(text).toContain('墙');
    expect(text).toContain('mineBlock');
    expect(text).not.toContain('已真正脱险');
  });
});

describe('C. 往下流的水柱 + 无出口：点明水流，并给出主动溺水这个真选项', () => {
  it('水下流且上浮无效 → 回执说"水在往下流，先横向离开"', async () => {
    const cells: Cells = new Map();
    for (let x = 0; x <= 5; x++) {
      for (let z = 27; z <= 31; z++) {
        for (let y = 50; y <= 80; y++) cells.set(key(x, y, z), 'water');
      }
    }
    const bot = columnBot(cells, { x: 3.7, y: 62.46, z: 29.3 }, { flowingLevel: 9 });
    expect(inDownwardCurrent(bot)).toBe(true);
    const text = await escapeWaterSkill(bot, noopToolDeps({ goTo: async () => false }));
    expect(text).toContain('往下流');
    expect(text).toContain('横向离开');
    expect(text).not.toContain('已真正脱险');
  });

  it('keepInventory=true ⇒ 主动溺水被明确说成"真选项"，代价写全（满血/经验都保留）', () => {
    const advice = deliberateDrownAdvice(true);
    expect(advice).toContain('keepInventory');
    expect(advice).toContain('满血');
    expect(advice).toContain('经验');
    expect(advice).toContain('主动溺水');
    expect(deliberateDrownAdvice(false)).toContain('不要');
    expect(deliberateDrownAdvice(false)).toContain('掉光背包');
    expect(deliberateDrownAdvice(null)).toContain('/gamerule');
    expect(deliberateDrownAdvice(null)).toContain('先确认');
  });

  it('无出口且没有 keepInventory 情报时，回执照样给出"先确认 gamerule"的版本', async () => {
    const cells: Cells = new Map();
    for (let x = 0; x <= 4; x++) {
      for (let z = 27; z <= 31; z++) {
        for (let y = 50; y <= 80; y++) cells.set(key(x, y, z), 'water');
      }
    }
    const bot = columnBot(cells, { x: 2.5, y: 60.5, z: 29.5 }, { flowingLevel: 9 });
    const text = await escapeWaterSkill(bot, noopToolDeps({ goTo: async () => false, keepInventory: null }));
    expect(text).toContain('keepInventory');
    expect(text).toContain('先确认');
  });
});
