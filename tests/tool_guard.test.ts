/**
 * 附魔工具保护的**外围入口**（用户 2026-11-01：pathfinder 挖路、custom-pvp 换武器也要保护）。
 *
 * 三块：
 *   1. `installToolGuard`：包住 `bot.dig`（pathfinder 裸挖）和
 *      `bot.swordpvp.checkForWeapon`（插件自动换武器）；
 *   2. 战斗侧选择：`readSelfFacts` / `bestWeaponInInventory` 不把保护线上的附魔武器算进去；
 *   3. 接线：body 启动时真的装了闸，`equipHighestAttack` / `attackEntity` 真的带保护。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installToolGuard } from '../src/body/safety/tool_guard.js';
import { readSelfFacts } from '../src/body/safety/combat_reflex.js';
import { bestWeaponInInventory } from '../src/body/library/skills.js';

const skillsSource = readFileSync(resolve(process.cwd(), 'src/body/library/skills.ts'), 'utf8');
const combatSource = readFileSync(resolve(process.cwd(), 'src/body/safety/combat_reflex.ts'), 'utf8');
const bodySource = readFileSync(resolve(process.cwd(), 'src/body/mineflayer_body.ts'), 'utf8');

interface FakeItem {
  name: string;
  type?: number;
  count?: number;
  maxDurability?: number;
  durabilityUsed?: number;
  enchants?: unknown;
}

/** 附魔钻石剑：剩 5 次耐久（1561 - 1556）⇒ 到保护线。 */
const PROTECTED_SWORD: FakeItem = {
  name: 'diamond_sword',
  type: 10,
  count: 1,
  maxDurability: 1561,
  durabilityUsed: 1556,
  enchants: [{ name: 'sharpness', lvl: 5 }],
};
/** 未附魔石剑：可用。 */
const PLAIN_SWORD: FakeItem = { name: 'stone_sword', type: 11, count: 1, maxDurability: 131, durabilityUsed: 0 };
/** 附魔铁镐：剩 11 次 ⇒ 到保护线。 */
const PROTECTED_PICK: FakeItem = {
  name: 'iron_pickaxe',
  type: 1,
  count: 1,
  maxDurability: 251,
  durabilityUsed: 240,
  enchants: [{ name: 'efficiency', lvl: 3 }],
};
const PLAIN_PICK: FakeItem = { name: 'stone_pickaxe', type: 2, count: 1, maxDurability: 131, durabilityUsed: 0 };

const STONE_BLOCK: any = {
  name: 'stone',
  harvestTools: { 1: true, 2: true },
  canHarvest: (type: number | null) => type === 1 || type === 2,
};

/** 假 bot：够 `installToolGuard` / `ensureHarvestTool` / 武器选择用。 */
function makeBot(items: FakeItem[], heldName: string | null): any {
  const state: { held: FakeItem | null } = {
    held: heldName == null ? null : items.find((item) => item.name === heldName) ?? null,
  };
  const bot: any = {
    game: { gameMode: 'survival', difficulty: 2 },
    health: 20,
    food: 20,
    foodSaturation: 0,
    entity: { isInWater: false, onGround: true },
    output: '',
    inventory: {
      slots: items,
      items: () => items,
      findInventoryItem: (name: string) => items.find((item) => item.name === name) ?? null,
    },
    get heldItem(): FakeItem | null {
      return state.held;
    },
    equip: (item: FakeItem): Promise<void> => {
      state.held = item;
      return Promise.resolve();
    },
    unequip: (): Promise<void> => {
      state.held = null;
      return Promise.resolve();
    },
    tool: { equipForBlock: (): Promise<void> => Promise.resolve() },
    // 裸 bot.dig：pathfinder 走的就是这个入口。
    dig: (): Promise<string> => {
      bot.__digs = (bot.__digs ?? 0) + 1;
      return Promise.resolve('dug');
    },
    stopDigging: (): void => {},
    // pathfinder：挖不动时要干净地停下（而不是卡在 digging=true 等超时）。
    pathfinder: {
      isMoving: (): boolean => true,
      isMining: (): boolean => true,
      stop: (): void => {
        bot.__pathStopped = true;
      },
    },
    // 最小事件总线：复位 pathfinder 的 digging 标志靠 diggingAborted。
    emit: (name: string, arg?: unknown): void => {
      (bot.__emitted ??= []).push({ name, arg });
    },
    // custom-pvp 的自动换武器：找背包里第一把名字含 weapon 的。
    swordpvp: {
      checkForWeapon: (weapon?: string): FakeItem | null =>
        items.find((item) => item.name.includes(weapon ?? 'sword')) ?? null,
    },
  };
  return bot;
}

describe('installToolGuard：bot.dig 闸（pathfinder 裸挖）', () => {
  it('手里是受保护附魔镐 + 背包有石镐 ⇒ 先换手再挖', async () => {
    const bot = makeBot([PROTECTED_PICK, PLAIN_PICK], 'iron_pickaxe');
    installToolGuard(bot);
    await expect(bot.dig(STONE_BLOCK, true)).resolves.toBe('dug');
    expect(bot.__digs).toBe(1);
    expect(bot.heldItem?.name).toBe('stone_pickaxe');
  });

  it('只有受保护附魔镐 ⇒ 拒绝这一镐（PROTECTED_TOOL），不调用原始 dig，回执说清', async () => {
    const bot = makeBot([PROTECTED_PICK], 'iron_pickaxe');
    installToolGuard(bot);
    await expect(bot.dig(STONE_BLOCK, true)).rejects.toMatchObject({ code: 'PROTECTED_TOOL' });
    expect(bot.__digs ?? 0).toBe(0);
    expect(bot.output).toContain('附魔工具');
    expect(bot.output).toContain('已保护');
    // 同一句话只写一次（pathfinder 会反复试同一格）。
    const first = bot.output;
    await expect(bot.dig(STONE_BLOCK, true)).rejects.toMatchObject({ code: 'PROTECTED_TOOL' });
    expect(bot.output).toBe(first);
  });

  it('拒绝时让 pathfinder 干净停下，并补一个 diggingAborted 复位它的 digging 标志', async () => {
    const bot = makeBot([PROTECTED_PICK], 'iron_pickaxe');
    installToolGuard(bot);
    await expect(bot.dig(STONE_BLOCK, true)).rejects.toMatchObject({ code: 'PROTECTED_TOOL' });
    expect(bot.__pathStopped).toBe(true);
    // 补事件在下一拍（那时 pathfinder 的 resetPath 已经挂上监听）。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((bot.__emitted ?? []).map((e: { name: string }) => e.name)).toContain('diggingAborted');
  });

  it('手里不是保护工具 ⇒ 直接放行（不换手、不拦）', async () => {
    const bot = makeBot([PLAIN_PICK], 'stone_pickaxe');
    installToolGuard(bot);
    await expect(bot.dig(STONE_BLOCK, true)).resolves.toBe('dug');
    expect(bot.__digs).toBe(1);
    expect(bot.heldItem?.name).toBe('stone_pickaxe');
  });

  it('重复安装不会重复包装', async () => {
    const bot = makeBot([PLAIN_PICK], 'stone_pickaxe');
    installToolGuard(bot);
    installToolGuard(bot);
    await expect(bot.dig(STONE_BLOCK, true)).resolves.toBe('dug');
    expect(bot.__digs).toBe(1);
  });
});

describe('installToolGuard：custom-pvp 换武器闸', () => {
  it('checkForWeapon 永不返回保护线上的附魔武器', () => {
    const bot = makeBot([PROTECTED_SWORD, PLAIN_SWORD], null);
    installToolGuard(bot);
    // 插件按 "sword" 找：第一把是受保护的钻石剑 → 必须被挡掉
    expect(bot.swordpvp.checkForWeapon('sword')?.name).toBe('stone_sword');
    // 明确要钻石剑也一样挡
    expect(bot.swordpvp.checkForWeapon('diamond_sword')).toBeNull();
  });

  it('没有保护武器时照常返回', () => {
    const bot = makeBot([PLAIN_SWORD], null);
    installToolGuard(bot);
    expect(bot.swordpvp.checkForWeapon('sword')?.name).toBe('stone_sword');
  });
});

describe('战斗侧选择：保护线上的附魔武器不参与', () => {
  it('readSelfFacts：只有受保护附魔剑 ⇒ weapon 为 null（按无武器评估）', () => {
    const bot = makeBot([PROTECTED_SWORD], null);
    expect(readSelfFacts(bot).weapon).toBeNull();
  });

  it('readSelfFacts：受保护附魔剑 + 石剑 ⇒ 按石剑评估（DPS 与实际换手一致）', () => {
    const bot = makeBot([PROTECTED_SWORD, PLAIN_SWORD], null);
    const weapon = readSelfFacts(bot).weapon;
    expect(weapon?.kind).toBe('sword');
    expect(weapon?.damage).toBe(5); // 石剑
  });

  it('bestWeaponInInventory：只有受保护附魔剑 ⇒ null（建议里也不出现）', () => {
    expect(bestWeaponInInventory(makeBot([PROTECTED_SWORD], null))).toBeNull();
    expect(bestWeaponInInventory(makeBot([PROTECTED_SWORD, PLAIN_SWORD], null))).toBe('stone_sword');
  });
});

describe('接线：body 启动与技能层真的带保护', () => {
  it('MineflayerBody 拿到 bot 后立刻装闸', () => {
    expect(bodySource).toContain('installToolGuard(this.bot)');
  });

  it('equipHighestAttack 过滤保护武器；没得换时把手上的保护武器放下', () => {
    const start = skillsSource.indexOf('async function equipHighestAttack');
    const region = skillsSource.slice(start, start + 2600);
    expect(region).toContain('isToolProtected');
    expect(region).toContain("equip(bot, 'hand')");
  });

  it('attackEntity 的击杀等待循环里会复查保护线（打到一半跌破也换手）', () => {
    const start = skillsSource.indexOf('export async function attackEntity');
    const region = skillsSource.slice(start, start + 9000);
    expect(region).toContain('isHeldToolProtected(bot)) await equipHighestAttack(bot)');
  });

  it('combat_reflex 的战力估算同样过滤保护武器', () => {
    const start = combatSource.indexOf('function bestWeaponFrom');
    const region = combatSource.slice(start, start + 900);
    expect(region).toContain('isToolProtected(item)');
  });
});
