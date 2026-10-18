/**
 * 生存安全：时间判断、庇护所评估、抗火/烈焰人准备、以及命令声明的自包含契约。
 *
 * 这些用例针对的错法大多是**静默的**：把白天算成夜晚、把露天当成有顶、
 * 把水/岩浆当普通方块挖、把抗火药水认错——每一条都不会抛异常，
 * 只会让机器人按错误前提行动。所以用纯函数 + 假身体钉死。
 */
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import {
  assessSurvival,
  carvePocket,
  countBeds,
  countFood,
  findNearbyCoveredSpot,
  FOOD_EMERGENCY_HEALTH,
  FOOD_REGEN_THRESHOLD,
  FOOD_RESERVE_COMFORT,
  FOOD_RESERVE_LOW,
  foodEmergencyLine,
  foodReserveAssets,
  foodReserveLine,
  formatSurvivalReport,
  isFireResistancePotion,
  isNightTime,
  normalizeEffectName,
  prepareBlazeSkill,
  renewableFoodHint,
  sampleSurvivalSignals,
  sleepUndergroundSkill,
  waitForDawn,
  shelterDigDepth,
  ticksUntilDawn,
  ticksUntilNight,
  type SurvivalSignals,
} from '../src/body/library/survival.js';
import { survivalActionList, survivalQueryList, SURVIVAL_POLICY, SURVIVAL_TOOL_TEXT } from '../src/body/commands/survival.js';
import { escapeWaterSkill, findNearestDrySpot, floatUpSkill, hasSupport, isInWater, isOnDryGround, isWaterBlockName, swimToward } from '../src/body/library/survival.js';
import { createToolCatalog } from '../src/brain/tools/catalog.js';
import { isActionTool, validateToolCall } from '../src/brain/tools/validate.js';
import type { ToolDeclaration, ToolKind } from '../src/shared/tools.js';
import { stripBang } from '../src/shared/tools.js';

// ---------------------------------------------------------------
// 时间：与 edges / live_state 同一套阈值（12542 入夜、23460 天亮）
// ---------------------------------------------------------------
describe('时间判断', () => {
  it('12542 起算夜晚，23460 起算白天', () => {
    expect(isNightTime(12541)).toBe(false);
    expect(isNightTime(12542)).toBe(true);
    expect(isNightTime(23459)).toBe(true);
    expect(isNightTime(23460)).toBe(false);
    expect(isNightTime(null)).toBe(false);
  });

  it('距天黑：白天倒数、夜里为 0、跨午夜按新一天算', () => {
    expect(ticksUntilNight(0)).toBe(12542);
    expect(ticksUntilNight(12000)).toBe(542);
    expect(ticksUntilNight(13000)).toBe(0);
    // 23500 已是第二天清晨，下一次天黑在下一轮的 12542。
    expect(ticksUntilNight(23500)).toBe(24000 - 23500 + 12542);
  });

  it('距天亮：夜里倒数、白天为 0', () => {
    expect(ticksUntilDawn(13000)).toBe(23460 - 13000);
    expect(ticksUntilDawn(12000)).toBe(0);
    expect(ticksUntilDawn(23500)).toBe(0);
  });
});

// ---------------------------------------------------------------
// 物资识别
// ---------------------------------------------------------------
describe('物资识别', () => {
  it('效果名归一成 fire_resistance（兼容 displayName 与 id 名）', () => {
    expect(normalizeEffectName('Fire Resistance')).toBe('fire_resistance');
    expect(normalizeEffectName('minecraft:fire_resistance')).toBe('fire_resistance');
  });

  it('只认带 fire_resistance NBT 的药水（两种 NBT 形状都认）', () => {
    expect(isFireResistancePotion({ name: 'potion', nbt: { value: { Potion: { value: 'minecraft:fire_resistance' } } } })).toBe(true);
    expect(isFireResistancePotion({ name: 'potion', nbt: { value: { Potion: 'minecraft:fire_resistance' } } })).toBe(true);
    expect(isFireResistancePotion({ name: 'potion', nbt: { value: { Potion: { value: 'minecraft:swiftness' } } } })).toBe(false);
    expect(isFireResistancePotion({ name: 'apple' })).toBe(false);
    expect(isFireResistancePotion(null)).toBe(false);
  });

  it('食物/床计数只认白名单', () => {
    expect(countFood({ cooked_beef: 3, dirt: 64, bread: 2 })).toBe(5);
    expect(countBeds({ red_bed: 1, blue_bed: 2, dirt: 1 })).toBe(3);
  });

  it('食物计数认两代物品名：手上的 mutton 必须算数（15:58 真机事故）', () => {
    // 旧行为：表里只有 raw_mutton，`mutton` 数不到 → "拿着食物报没有食物"
    expect(countFood({ mutton: 2 })).toBe(2);
    expect(countFood({ mutton: 2, raw_mutton: 1, cooked_mutton: 3, dirt: 64 })).toBe(6);
    expect(countFood({ porkchop: 1, beef: 2, chicken: 1, cod: 1, salmon: 1, rabbit: 1 })).toBe(7);
    // 不是食物的一律不算
    expect(countFood({ stone: 64, mutton: 1 })).toBe(1);
  });
});

// ---------------------------------------------------------------
// 纯决策
// ---------------------------------------------------------------
const baseSignals = (over: Partial<SurvivalSignals> = {}): SurvivalSignals => ({
  dimension: 'overworld',
  timeOfDay: 12000,
  x: 0,
  y: 64,
  z: 0,
  surfaceY: 64,
  roofBlock: null,
  roofReadable: true,
  health: 20,
  food: 20,
  effects: [],
  hostiles: [],
  inventory: {},
  bedCount: 0,
  foodCount: 0,
  fireResistPotionCount: 0,
  ...over,
});

describe('assessSurvival：庇护与夜晚建议', () => {
  it('夜里露天且有怪：建议立刻 seekShelter，并报出最近威胁', () => {
    const a = assessSurvival(baseSignals({ timeOfDay: 14000, hostiles: [{ name: 'zombie', distance: 5 }] }));
    expect(a.isNight).toBe(true);
    expect(a.sheltered).toBe(false);
    expect(a.hostileCount).toBe(1);
    expect(a.nearestHostile?.name).toBe('zombie');
    expect(a.advice).toContain('seekShelter');
  });

  it('白天离天黑很近：提前提醒 seekShelter', () => {
    const a = assessSurvival(baseSignals({ timeOfDay: 12542 - 500 }));
    expect(a.isNight).toBe(false);
    expect(a.advice).toContain('seekShelter');
  });

  it('地下有顶 = sheltered；头顶读不到时不算安全（别假报）', () => {
    const covered = assessSurvival(baseSignals({ y: 50, surfaceY: 64, roofBlock: 'stone' }));
    expect(covered.underground).toBe(true);
    expect(covered.roofed).toBe(true);
    expect(covered.sheltered).toBe(true);

    const unknownRoof = assessSurvival(baseSignals({ y: 50, surfaceY: 64, roofBlock: null, roofReadable: false }));
    expect(unknownRoof.roofed).toBeNull();
    expect(unknownRoof.sheltered).toBe(false);
  });

  it('夜里在地下且有床：建议 sleepUnderground；没床则在地下等', () => {
    const withBed = assessSurvival(baseSignals({ timeOfDay: 14000, y: 50, roofBlock: 'stone', bedCount: 1 }));
    expect(withBed.advice).toContain('sleepUnderground');
    const noBed = assessSurvival(baseSignals({ timeOfDay: 14000, y: 50, roofBlock: 'stone', bedCount: 0 }));
    expect(noBed.advice).toContain('sleepUnderground');
  });
});

describe('assessSurvival：烈焰人准备', () => {
  it('没火抗没食物：blazeReady=false，缺件写清楚', () => {
    const a = assessSurvival(baseSignals());
    expect(a.fireResistReady).toBe(false);
    expect(a.blazeReady).toBe(false);
    expect(a.missing.join('、')).toContain('抗火药水');
    expect(a.missing.join('、')).toContain('食物');
  });

  it('身上有火抗 Buff 且有食物：就绪', () => {
    const a = assessSurvival(baseSignals({
      effects: [{ name: 'Fire Resistance', amplifier: 0, durationSeconds: 180 }],
      foodCount: 3,
    }));
    expect(a.fireResistSeconds).toBe(180);
    expect(a.fireResistReady).toBe(true);
    expect(a.blazeReady).toBe(true);
  });

  it('Buff 快没了但有库存药水：仍算可续（prepareBlaze 会喝）', () => {
    const a = assessSurvival(baseSignals({
      effects: [{ name: 'Fire Resistance', amplifier: 0, durationSeconds: 10 }],
      fireResistPotionCount: 1,
      foodCount: 3,
    }));
    expect(a.fireResistReady).toBe(true);
    expect(a.fireResistCoverSeconds).toBe(10 + 180);
  });

  it('血量太低时不算就绪', () => {
    const a = assessSurvival(baseSignals({
      effects: [{ name: 'Fire Resistance', amplifier: 0, durationSeconds: 180 }],
      foodCount: 3,
      health: 4,
    }));
    expect(a.blazeReady).toBe(false);
    expect(a.missing.join('、')).toContain('血量');
  });
});

describe('shelterDigDepth：目标落到地表下 3 格，夹在 2~6', () => {
  it('站在地表：挖 3 格', () => {
    expect(shelterDigDepth(64, 64)).toBe(3);
  });
  it('离地表很高：最多 6 格', () => {
    expect(shelterDigDepth(100, 64)).toBe(6);
  });
  it('已经在地下：至少还挖 2 格（掏窝前先确保离地表）', () => {
    expect(shelterDigDepth(62, 64)).toBe(2);
  });
  it('读不到坐标时给保守默认值 3', () => {
    expect(shelterDigDepth(null, null)).toBe(3);
  });
});

describe('formatSurvivalReport：报告要有时间/掩体/物资/建议', () => {
  it('关键行都在', () => {
    const text = formatSurvivalReport(assessSurvival(baseSignals({
      timeOfDay: 14000,
      y: 50,
      roofBlock: 'stone',
      bedCount: 1,
      foodCount: 4,
      effects: [{ name: 'Fire Resistance', amplifier: 0, durationSeconds: 120 }],
    })));
    expect(text).toContain('生存检查');
    expect(text).toContain('夜晚');
    expect(text).toContain('掩体：有');
    expect(text).toContain('床 1 张');
    expect(text).toContain('抗火药水：Buff 120s');
    expect(text).toContain('建议：');
  });
});

// ---------------------------------------------------------------
// 采样：用假身体
// ---------------------------------------------------------------
interface FakeBlock { name: string; transparent?: boolean; diggable?: boolean }
type BlockMap = Record<string, FakeBlock>;

function fakeBody(blocks: BlockMap, opts: {
  y?: number;
  height?: number;
  effects?: any[];
  entities?: Record<string, any>;
  slots?: Array<{ name: string; count: number }>;
  items?: any[];
} = {}) {
  const y = opts.y ?? 60;
  const pos = new Vec3(0, y, 0);
  const blockAt = (p: any): FakeBlock => blocks[`${p.x},${p.y},${p.z}`] ?? { name: 'air' };
  const itemList = opts.items ?? [];
  const slots = opts.slots ?? [];
  const bot: any = {
    entity: { id: 99, position: pos, yaw: 0, effects: opts.effects ?? [] },
    game: { height: opts.height ?? 80, dimension: 'overworld' },
    time: { timeOfDay: 14000 },
    health: 20,
    food: 18,
    entities: opts.entities ?? {},
    registry: { effects: { '12': { id: 12, displayName: 'Fire Resistance' } } },
    inventory: {
      slots,
      items: () => itemList,
      findInventoryItem: (name: string) => itemList.find((i) => i.name === name),
    },
    blockAt,
    output: '',
    equip: vi.fn(() => Promise.resolve()),
    consume: vi.fn(() => Promise.resolve()),
  };
  return bot;
}

describe('sampleSurvivalSignals：从假身体读事实', () => {
  it('读出土下/有顶/威胁/床/食物/火抗 Buff', () => {
    const blocks: BlockMap = { '0,64,0': { name: 'stone' } };
    const bot = fakeBody(blocks, {
      y: 60,
      effects: [{ id: 12, amplifier: 0, duration: 240 }],
      entities: {
        1: { id: 1, name: 'zombie', position: new Vec3(3, 60, 0) },
        2: { id: 2, name: 'cow', position: new Vec3(2, 60, 0) },
        99: { id: 99, name: 'player', position: new Vec3(0, 60, 0) },
      },
      slots: [
        { name: 'red_bed', count: 1 },
        { name: 'cooked_beef', count: 2 },
        { name: 'dirt', count: 64 },
      ],
      items: [{ name: 'potion', nbt: { value: { Potion: { value: 'minecraft:fire_resistance' } } } }],
    });
    const s = sampleSurvivalSignals(bot);
    expect(s.surfaceY).toBe(64);
    expect(s.roofBlock).toBe('stone');
    expect(s.roofReadable).toBe(true);
    expect(s.hostiles.map((h) => h.name)).toEqual(['zombie']); // 牛和自己不算
    expect(s.bedCount).toBe(1);
    expect(s.foodCount).toBe(2);
    expect(s.fireResistPotionCount).toBe(1);
    const a = assessSurvival(s);
    expect(a.underground).toBe(true);
    expect(a.sheltered).toBe(true);
    expect(a.fireResistSeconds).toBe(12); // 240 tick = 12 秒
  });
});

describe('findNearbyCoveredSpot：只认脚下有地板、头顶有顶的空间', () => {
  it('找到一个有顶空间', () => {
    const blocks: BlockMap = {
      '1,60,0': { name: 'air' },
      '1,61,0': { name: 'air' },
      '1,62,0': { name: 'stone' },
      '1,59,0': { name: 'stone' },
    };
    const bot = fakeBody(blocks);
    bot.findBlocks = () => [new Vec3(1, 60, 0)];
    expect(findNearbyCoveredSpot(bot)).toEqual({ x: 1, y: 60, z: 0 });
  });

  it('头顶露天的不算', () => {
    const blocks: BlockMap = {
      '1,60,0': { name: 'air' },
      '1,61,0': { name: 'air' },
      '1,62,0': { name: 'air' },
      '1,59,0': { name: 'stone' },
    };
    const bot = fakeBody(blocks);
    bot.findBlocks = () => [new Vec3(1, 60, 0)];
    expect(findNearbyCoveredSpot(bot)).toBeNull();
  });
});

describe('carvePocket：危险方向直接跳过，不挖水/岩浆', () => {
  it('四周是水/岩浆时返回 false 且不动', async () => {
    const blocks: BlockMap = {};
    for (const [dx, dz] of [[0, -1], [0, 1], [1, 0], [-1, 0]] as Array<[number, number]>) {
      blocks[`${dx},60,${dz}`] = { name: 'lava', diggable: true };
      blocks[`${dx},61,${dz}`] = { name: 'lava', diggable: true };
      blocks[`${dx},62,${dz}`] = { name: 'stone' };
    }
    const bot = fakeBody(blocks);
    expect(await carvePocket(bot)).toBe(false);
  });
});

// ---------------------------------------------------------------
// 动作：prepareBlaze 喝药 + 吃
// ---------------------------------------------------------------
describe('prepareBlazeSkill', () => {
  it('有火抗药水就先喝、饿了就吃，最后报就绪', async () => {
    const blocks: BlockMap = { '0,64,0': { name: 'stone' } };
    const potion = { name: 'potion', nbt: { value: { Potion: { value: 'minecraft:fire_resistance' } } } };
    const bot = fakeBody(blocks, {
      y: 60,
      slots: [
        { name: 'cooked_beef', count: 2 },
        { name: 'potion', count: 1 },
      ],
      items: [potion, { name: 'cooked_beef', count: 2 }],
    });
    // fakeBody 的 food 固定 18，这里按需求压低。
    bot.food = 10;
    const text = await prepareBlazeSkill(bot);
    expect(bot.equip).toHaveBeenCalledWith(potion, 'hand');
    expect(text).toContain('喝下抗火药水');
    expect(text).toContain('cooked_beef');
    expect(text).toContain('准备就绪');
  });

  it('既没药水也没食物：如实报缺件，不假装就绪', async () => {
    const blocks: BlockMap = { '0,64,0': { name: 'stone' } };
    const bot = fakeBody(blocks, { y: 60 });
    const text = await prepareBlazeSkill(bot);
    expect(text).toContain('没有抗火药水');
    expect(text).toContain('没有食物');
    expect(text).not.toContain('准备就绪');
  });

  it('手上拿着 mutton（1.13 短名）时绝不能说"没有食物"，并且真的吃掉它', async () => {
    const blocks: BlockMap = { '0,64,0': { name: 'stone' } };
    const bot = fakeBody(blocks, {
      y: 60,
      effects: [{ id: 12, amplifier: 0, duration: 3600 }], // 已有抗火 Buff：不喝药，只看吃
      slots: [{ name: 'mutton', count: 2 }],
      items: [{ name: 'mutton', count: 2 }],
    });
    bot.food = 8;
    // 真吃进去了：consume 之后饱食度真的涨（consume 就按这个事实判定成功）
    bot.consume = vi.fn(async () => {
      bot.food = 20;
      bot.foodSaturation = 5;
    });

    const text = await prepareBlazeSkill(bot);
    expect(text).not.toContain('没有食物');
    expect(text).toContain('吃了 mutton');
    expect(bot.equip).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------
// 命令声明：自包含、名字/描述/长动作标记一致
// ---------------------------------------------------------------
describe('命令声明', () => {
  it('查询命令是 survivalCheck，且 perform 返回报告', () => {
    const command = survivalQueryList.find((c) => c.name === '!survivalCheck');
    expect(command).toBeDefined();
    const blocks: BlockMap = {};
    const bot = fakeBody(blocks);
    const text = String((command as any).perform({ bot }));
    expect(text).toContain('生存检查');
  });

  it('三个动作都带 longRunning 标记（走身体通道）', () => {
    for (const name of ['!seekShelter', '!sleepUnderground', '!prepareBlaze']) {
      const command = survivalActionList.find((c) => c.name === name);
      expect(command, name).toBeDefined();
      expect((command as any).perform.longRunning, name).toBe(true);
    }
  });

  it('SURVIVAL_TOOL_TEXT 与命令名一一对应', () => {
    const names = [...survivalQueryList, ...survivalActionList].map((c) => c.name.replace(/^!/, ''));
    expect(Object.keys(SURVIVAL_TOOL_TEXT).sort()).toEqual(names.sort());
  });

  it('提示词政策提到四个工具', () => {
    for (const tool of ['survivalCheck', 'seekShelter', 'sleepUnderground', 'prepareBlaze']) {
      expect(SURVIVAL_POLICY).toContain(tool);
    }
  });
});

describe('读不到时间时不能假报白天/天亮', () => {
  it('sleepUnderground：时间读不到就不判断白天黑夜，留在地下', async () => {
    const blocks: BlockMap = { '0,64,0': { name: 'stone' } };
    const bot = fakeBody(blocks, { y: 60 });
    bot.time.timeOfDay = null;
    const text = await sleepUndergroundSkill(bot);
    expect(text).toContain('读不到游戏时间');
    expect(text).not.toContain('天亮前在地下睡了一觉');
  });

  it('waitForDawn：时间读不到就不当成天亮', async () => {
    const bot = fakeBody({});
    bot.time.timeOfDay = null;
    bot.interrupt_code = true; // 让 stay 立刻返回，测试只跑 50ms
    const text = await waitForDawn(bot, 0.05);
    expect(text).not.toContain('已经天亮');
  });
});

// ---------------------------------------------------------------
// 接入契约：把两个列表按 registry 的方式转成声明后，大脑侧必须认
// ---------------------------------------------------------------
function declarationOf(command: any, kind: ToolKind): ToolDeclaration {
  const declaration: ToolDeclaration = { name: stripBang(command.name), description: command.description, kind };
  if (command.params !== undefined) declaration.params = command.params;
  if (command.perform?.longRunning === true) declaration.longRunning = true;
  return declaration;
}

describe('registry 接入契约（不依赖共享入口改动）', () => {
  const declarations: ToolDeclaration[] = [
    ...survivalQueryList.map((c) => declarationOf(c, 'query')),
    ...survivalActionList.map((c) => declarationOf(c, 'action')),
  ];
  const catalog = createToolCatalog(declarations);

  it('四个声明都能建进工具目录，且 channel 归属正确', () => {
    expect(declarations.map((d) => d.name).sort()).toEqual(
      ['escapeWater', 'fillBucketFromSource', 'findFluidSource', 'prepareBlaze', 'seekShelter', 'sleepUnderground', 'survivalCheck'].sort(),
    );
    expect(isActionTool(catalog, 'survivalCheck')).toBe(false);
    expect(isActionTool(catalog, 'findFluidSource')).toBe(false);
    for (const name of ['escapeWater', 'fillBucketFromSource', 'seekShelter', 'sleepUnderground', 'prepareBlaze']) {
      expect(isActionTool(catalog, name), name).toBe(true);
    }
  });

  it('大脑侧参数校验放行空参数、拒绝多余参数', () => {
    for (const name of ['survivalCheck', 'seekShelter', 'sleepUnderground', 'prepareBlaze']) {
      expect(validateToolCall(catalog, name, {}).ok, name).toBe(true);
      expect(validateToolCall(catalog, name, { foo: 1 }).ok, name).toBe(false);
    }
  });
});

/**
 * 水中脱困（task-28）：方向只准向上/干岸，禁止更低水位；"已上岸"必须
 * 脚/头不在水 + 脚下实心 + 连续确认；危险时先向上挖/上浮；回执带水位变化。
 */
function fakeLakeBot(opts: { x?: number } = {}) {
    const pos = new Vec3(opts.x ?? 0.5, 60, 0.5);
    const controls: Record<string, boolean> = {};
    const blockAt = (p: any): { name: string } => {
        const x = Math.round(Number(p.x));
        const y = Math.round(Number(p.y));
        const z = Math.round(Number(p.z));
        if (z !== 0) return { name: 'air' };
        if (x <= 1) {
            if (y === 60 || y === 61) return { name: 'water' };
            if (y === 59) return { name: 'stone' };
            return { name: 'air' };
        }
        if (y === 60 || y === 61) return { name: 'air' };
        if (y === 59) return { name: 'stone' };
        return { name: 'air' };
    };
    const bot: any = {
        entity: { position: pos, yaw: 0 },
        interrupt_code: false,
        output: '',
        blockAt,
        lookAt: () => Promise.resolve(),
        setControlState: (key: string, down: boolean) => {
            controls[key] = down;
            if (down && key === 'forward') pos.x = Math.round((pos.x + 0.6) * 10) / 10;
        },
        _controls: controls,
    };
    return bot;
}

/** 只按 map 读方块的假身体；map 缺省是 air。 */
function mapBot(map: Record<string, string>, pos = new Vec3(0.5, 60, 0.5)) {
    return {
        entity: { position: pos, yaw: 0 },
        interrupt_code: false,
        output: '',
        blockAt: (p: any) => ({ name: map[`${Math.round(Number(p.x))},${Math.round(Number(p.y))},${Math.round(Number(p.z))}`] ?? 'air' }),
    };
}

describe('isWaterBlockName / isInWater / hasSupport', () => {
    it('水和含水方块都算水；石头不算', () => {
        expect(isWaterBlockName('water')).toBe(true);
        expect(isWaterBlockName('flowing_water')).toBe(true);
        expect(isWaterBlockName('seagrass')).toBe(true);
        expect(isWaterBlockName('stone')).toBe(false);
        expect(isWaterBlockName(null)).toBe(false);
    });

    it('脚在水里 → isInWater=true；湖底石头 → hasSupport=true', () => {
        const bot = fakeLakeBot();
        expect(isInWater(bot)).toBe(true);
        expect(hasSupport(bot)).toBe(true);
    });
});

describe('isOnDryGround：硬校验（脚/头不在水 + 脚下实心）', () => {
    it('脚/头空气、脚下实心 → true', () => {
        expect(isOnDryGround(mapBot({ '0,60,0': 'air', '0,61,0': 'air', '0,59,0': 'stone' }))).toBe(true);
    });

    it('脚在水里 / 头在水里 / 脚下是水 / 脚下是空气 → 都 false', () => {
        expect(isOnDryGround(mapBot({ '0,60,0': 'water', '0,61,0': 'air', '0,59,0': 'stone' }))).toBe(false);
        expect(isOnDryGround(mapBot({ '0,60,0': 'air', '0,61,0': 'water', '0,59,0': 'stone' }))).toBe(false);
        expect(isOnDryGround(mapBot({ '0,60,0': 'air', '0,61,0': 'air', '0,59,0': 'water' }))).toBe(false);
        expect(isOnDryGround(mapBot({ '0,60,0': 'air', '0,61,0': 'air', '0,59,0': 'air' }))).toBe(false);
    });
});

describe('findNearestDrySpot：只向上/同层，绝不选更低水位', () => {
    it('同层最近的干岸，waterRise=0', () => {
        const bot = mapBot({ '2,60,0': 'air', '2,61,0': 'air', '2,59,0': 'stone' });
        expect(findNearestDrySpot(bot, 16)).toMatchObject({ x: 2, y: 60, z: 0, waterRise: 0 });
    });

    it('★只有更低的水位（dy<0）时不返回，宁可报没找到', () => {
        const bot = mapBot({ '2,59,0': 'air', '2,60,0': 'air', '2,58,0': 'stone' });
        expect(findNearestDrySpot(bot, 16)).toBeNull();
    });

    it('同层没有时看上方，waterRise>0（抬高一级的干岸）', () => {
        const bot = mapBot({ '2,60,0': 'stone', '2,61,0': 'air', '2,62,0': 'air' });
        expect(findNearestDrySpot(bot, 16)).toMatchObject({ x: 2, y: 61, waterRise: 1 });
    });

    it('同层近岸优先于更高的岸', () => {
        const bot = mapBot({
            '2,60,0': 'air', '2,61,0': 'air', '2,59,0': 'stone',
            '3,62,0': 'air', '3,63,0': 'air', '3,61,0': 'stone',
        });
        expect(findNearestDrySpot(bot, 16)).toMatchObject({ y: 60, waterRise: 0 });
    });

    it('全是水时返回 null', () => {
        const bot = mapBot({});
        bot.blockAt = (p: any) => ({ name: Number(p.y) <= 61 ? 'water' : 'stone' });
        expect(findNearestDrySpot(bot, 4)).toBeNull();
    });
});

describe('escapeWaterSkill：不再越逃越深 / 不再误报', () => {
    it('不在水里时直接说不用', async () => {
        const bot = fakeLakeBot({ x: 5 });
        const text = await escapeWaterSkill(bot, { goTo: () => Promise.resolve(false), sleep: () => Promise.resolve() });
        expect(text).toContain('不在水里');
    });

    it('手动游上同层干岸：硬校验通过 + 回执带水位变化 + 松开所有按键', async () => {
        const bot = fakeLakeBot();
        const text = await escapeWaterSkill(bot, {
            goTo: () => Promise.resolve(false),
            mineUp: () => Promise.resolve(false),
            sleep: () => Promise.resolve(),
            maxMs: 5000,
        });
        expect(text).toContain('已真正脱险');
        expect(text).toContain('水位变化');
        expect(text).not.toContain('没能脱险');
        expect(bot._controls['forward']).toBe(false);
        expect(bot._controls['jump']).toBe(false);
    });

    it('★抬高一级的干岸：往上浮，回执显示水位上浮', async () => {
        const pos = new Vec3(0.5, 60, 0.5);
        const controls: Record<string, boolean> = {};
        const blockAt = (p: any): { name: string } => {
            const x = Math.round(Number(p.x));
            const y = Math.round(Number(p.y));
            const z = Math.round(Number(p.z));
            if (z !== 0) return { name: 'air' };
            if (x <= 1) {
                if (y === 60 || y === 61) return { name: 'water' };
                if (y === 59) return { name: 'stone' };
                return { name: 'air' };
            }
            if (y <= 60) return { name: 'stone' };
            return { name: 'air' };
        };
        const bot: any = {
            entity: { position: pos, yaw: 0 },
            interrupt_code: false,
            output: '',
            blockAt,
            lookAt: () => Promise.resolve(),
            setControlState: (key: string, down: boolean) => {
                controls[key] = down;
                if (down && key === 'forward') pos.x = Math.round((pos.x + 0.6) * 10) / 10;
                if (down && key === 'jump') pos.y = Math.round((pos.y + 0.5) * 10) / 10;
            },
            _controls: controls,
        };
        const text = await escapeWaterSkill(bot, {
            goTo: () => Promise.resolve(false),
            mineUp: () => Promise.resolve(false),
            sleep: () => Promise.resolve(),
            maxMs: 5000,
        });
        expect(text).toContain('已真正脱险');
        expect(text).toContain('上浮');
        expect(pos.y).toBeGreaterThan(60);
    });

    it('★始终没上岸：明确说 没能脱险，绝不假报，并给出水位变化', async () => {
        const bot = fakeLakeBot();
        bot.blockAt = (p: any) => ({ name: Number(p.y) <= 61 ? 'water' : 'stone' });
        const text = await escapeWaterSkill(bot, {
            goTo: () => Promise.resolve(false),
            mineUp: () => Promise.resolve(false),
            sleep: () => Promise.resolve(),
            maxMs: 200,
        });
        expect(text).toContain('浅水坑困死');
        expect(text).toContain('水位变化');
        expect(text).not.toContain('已真正脱险');
        expect(text).toContain('不要往下游');
    });
});

describe('swimToward：必须连续确认，单次瞬时干地不算数', () => {
    it('只干一瞬间、随后仍在水里 → escaped=false', async () => {
        let first = true;
        const bot: any = {
            entity: { position: new Vec3(0.5, 60, 0.5), yaw: 0 },
            interrupt_code: false,
            setControlState: () => undefined,
            lookAt: () => Promise.resolve(),
            blockAt: (p: any) => {
                const y = Math.round(Number(p.y));
                if (y === 60) {
                    if (first) { first = false; return { name: 'air' }; }
                    return { name: 'water' };
                }
                if (y === 61) return { name: 'air' };
                if (y === 59) return { name: 'stone' };
                return { name: 'air' };
            },
        };
        const result = await swimToward(bot, { x: 0, y: 60, z: 0 }, {
            sleep: () => Promise.resolve(),
            now: () => Date.now(),
            maxMs: 300,
            mineUp: () => Promise.resolve(false),
            confirmTicks: 3,
            startY: 60,
        });
        expect(result.escaped).toBe(false);
    });
});

describe('floatUpSkill：危险时先向上挖，不往前下方游', () => {
    it('头顶实心 → 向上挖开，且从不按 forward', async () => {
        const controls: Record<string, boolean> = {};
        const mineCalls: Array<{ x: number; y: number; z: number }> = [];
        const forwardPresses = { n: 0 };
        let ceiling = true;
        const bot: any = {
            entity: { position: new Vec3(0.5, 60, 0.5), yaw: 0 },
            interrupt_code: false,
            blockAt: (p: any) => {
                const y = Math.round(Number(p.y));
                const z = Math.round(Number(p.z));
                if (z !== 0) return { name: 'air' };
                if (y === 60) return { name: 'water' };
                if (y === 62 && ceiling) return { name: 'stone' };
                if (y === 59) return { name: 'stone' };
                return { name: 'air' };
            },
            setControlState: (key: string, down: boolean) => {
                controls[key] = down;
                if (key === 'forward' && down) forwardPresses.n += 1;
            },
        };
        const res = await floatUpSkill(bot, {
            sleep: () => Promise.resolve(),
            now: () => Date.now(),
            maxMs: 50,
            mineUp: (_b, x, y, z) => {
                mineCalls.push({ x, y, z });
                ceiling = false;
                return Promise.resolve(true);
            },
        });
        expect(mineCalls.length).toBeGreaterThan(0);
        expect(mineCalls[0].y).toBe(62);
        expect(forwardPresses.n).toBe(0);
        expect(res.ok).toBe(false);
    });
});

// ---------------------------------------------------------------
// 食物储备：告急线 + 存粮线（真机：血 1.68 / food 2 / 全世界没有食物）
// ---------------------------------------------------------------
describe('食物储备：告急与存粮', () => {
    it('资产盘点：种子/线/木棍/木板/生肉分开算（"能吃的份数"不在这里——那是 foodCount）', () => {
        const assets = foodReserveAssets({
            wheat_seeds: 12,
            string: 2,
            stick: 5,
            oak_planks: 4,
            raw_beef: 3,
            cooked_beef: 2,
            stone: 64,
        });
        expect(assets.seeds).toBe(12);
        expect(assets.string).toBe(2);
        expect(assets.sticks).toBe(5);
        expect(assets.planks).toBe(4);
        expect(assets.rawItems).toEqual([{ name: 'raw_beef', count: 3, cooked: 'cooked_beef' }]);
        // 种子/线/木棍都不是"能吃的"：同一个概念只走 foodValueOf / countFood
        expect(countFood({ wheat_seeds: 12, string: 2, stick: 5, oak_planks: 4 })).toBe(0);
    });

    it('路线提示：有材料就说得出来怎么做，没材料就如实说', () => {
        const rich = foodReserveAssets({ stick: 3, string: 2, wheat_seeds: 4, oak_planks: 2 });
        const hint = renewableFoodHint(rich);
        expect(hint).toContain('fishing_rod');
        expect(hint).toContain('4 个种子');
        expect(renewableFoodHint(foodReserveAssets({}))).toContain('没有种子/线/木棍');
    });

    it('告急线：**三个条件同时成立**才说（血低 + food < 18 + 背包没有能吃的）', () => {
        const base = { health: 8, food: 6, edibles: 0 };
        const line = foodEmergencyLine(base);
        expect(line).toContain('食物告急');
        expect(line).toContain(`低于回血线 ${FOOD_REGEN_THRESHOLD}`);
        expect(line).toContain('背包没有能吃的东西');
        expect(line).toContain('先别打');
        // 少任何一个条件都不说
        expect(foodEmergencyLine({ ...base, edibles: 1 })).toBeNull(); // 有吃的
        expect(foodEmergencyLine({ ...base, food: FOOD_REGEN_THRESHOLD })).toBeNull(); // 还能回血
        expect(foodEmergencyLine({ ...base, health: FOOD_EMERGENCY_HEALTH + 0.5 })).toBeNull(); // 血还够
        expect(foodEmergencyLine({ health: null, food: 6, edibles: 0 })).toBeNull(); // 读不到就不猜
        expect(foodEmergencyLine({ health: 8, food: null, edibles: 0 })).toBeNull();
    });

    it('告急线按家底给出具体路线（有线和木棍就点名钓鱼竿）', () => {
        const line = foodEmergencyLine({
            health: 2,
            food: 0,
            edibles: 0,
            assets: foodReserveAssets({ stick: 3, string: 2, wheat_seeds: 9 }),
        });
        expect(line).toContain('fishing_rod');
        expect(line).toContain('9 个种子');
    });

    it('存粮线：还有吃的但 ≤2 份 + food < 14 才提醒', () => {
        const line = foodReserveLine({ health: 20, food: 10, edibles: FOOD_RESERVE_LOW });
        expect(line).toContain(`存粮只剩 ${FOOD_RESERVE_LOW} 份`);
        expect(line).toContain('趁现在去补');
        expect(line).toContain(`别等饿到 ${FOOD_REGEN_THRESHOLD} 以下`);
        expect(foodReserveLine({ health: 20, food: 10, edibles: 3 })).toBeNull(); // 还够
        expect(foodReserveLine({ health: 20, food: FOOD_RESERVE_COMFORT, edibles: 1 })).toBeNull(); // 不饿
        expect(foodReserveLine({ health: 20, food: 10, edibles: 0 })).toBeNull(); // 没吃的走告急线
    });

    it('生肉提醒"先烤"（熟食值约一倍）', () => {
        const line = foodReserveLine({
            health: 20,
            food: 10,
            edibles: 1,
            assets: foodReserveAssets({ raw_beef: 1 }),
        });
        expect(line).toContain('是生的');
        expect(line).toContain('cooked_beef');
        expect(line).toContain('furnace');
    });

    it('打烈焰人前被存粮规则拦下 → 说"存粮先留着"，不谎报"没吃成"', async () => {
        const blocks: BlockMap = { '0,64,0': { name: 'stone' } };
        const bot = fakeBody(blocks, {
            y: 60,
            effects: [{ id: 12, amplifier: 0, duration: 3600 }], // 已有抗火 Buff：只看吃
            slots: [{ name: 'cooked_beef', count: 1 }],
            items: [{ name: 'cooked_beef', count: 1 }],
        });
        // food 16（≥ 存粮线 14）+ 背包只剩 1 份 → consume 会按存粮规则拒绝
        bot.food = 16;
        const text = await prepareBlazeSkill(bot);
        expect(text).toContain('存粮先留着');
        const refresh = assessSurvival(sampleSurvivalSignals(bot));
        expect(refresh.foodCount).toBe(1);
        expect(text).not.toContain('没吃成');
    });

    it('**不该吵人的情况**：满血 + 8 块牛排 → 两条线都不出现', () => {
        const report = formatSurvivalReport(
            assessSurvival(baseSignals({ health: 20, food: 20, inventory: { cooked_beef: 8 }, foodCount: 8 })),
        );
        expect(report).not.toContain('食物告急');
        expect(report).not.toContain('存粮只剩');
    });

    it('端到端：报告里真的会出现那两条线（各出现一次）', () => {
        const emergency = formatSurvivalReport(
            assessSurvival(baseSignals({ health: 3, food: 2, inventory: { wheat_seeds: 4 }, foodCount: 0 })),
        );
        expect(emergency).toContain('食物告急');
        expect(emergency).toContain('先别打');
        // 背包 → 资产 → 路线提示，这条链路要在报告里真的通（有种子就点名种小麦）
        expect(emergency).toContain('4 个种子');

        const reserve = formatSurvivalReport(
            assessSurvival(baseSignals({ health: 20, food: 10, inventory: { bread: 1 }, foodCount: 1 })),
        );
        expect(reserve).toContain('存粮只剩 1 份');
        expect(reserve).not.toContain('食物告急');

        // 有 5 份 + 不饿：两条都不出现
        const fine = formatSurvivalReport(
            assessSurvival(baseSignals({ health: 20, food: 16, inventory: { bread: 5 }, foodCount: 5 })),
        );
        expect(fine).not.toContain('存粮只剩');
        expect(fine).not.toContain('食物告急');
    });
});
