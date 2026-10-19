/**
 * 出发前准备检查 —— 真机 2026-10-19 07:00。
 *
 * overnight_a 走过虚空桥、第一次踏上末地主岛（当晚最远进度），随后
 * `was slain by Enderman`，**死亡背包里只有 dirt×10**：没有武器、没有盾、没有食物。
 * 它空手走进了 40 血、每下 4-7 伤害的末影人堆里。
 *
 * 食物那条（<12 不许进下界）一直靠人在聊天里说，说了好几次仍然发生；今天所有真正
 * 生效的约束都是引擎强制的。所以这条进引擎：**只拦"进入"，只做粗糙检查，能救就救。**
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEPARTURE_TOOLS,
  annotateReceipt,
  departureVerdict,
  isWeaponName,
  targetDimensionOf,
} from '../src/body/safety/departure_guard.js';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

const facts = (over: Partial<Parameters<typeof departureVerdict>[0]> = {}) => ({
  tool: 'enterEnd',
  dimension: 'minecraft:overworld',
  health: 20,
  food: 20,
  weapon: 'iron_sword',
  blocks: 32,
  ...over,
});

function departureBody(items: Array<{ name: string; count: number }>, over: Record<string, unknown> = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  const blocksByName: Record<string, unknown> = {};
  for (const name of ['dirt', 'cobblestone', 'oak_planks', 'stone']) blocksByName[name] = { boundingBox: 'block' };
  const state: any = { held: over.held ?? null };
  const bot: any = {
    health: over.health ?? 20,
    food: over.food ?? 20,
    game: { dimension: (over.dimension as string) ?? 'minecraft:overworld' },
    inventory: { items: () => items },
    registry: { blocksByName },
    get heldItem() {
      return state.held;
    },
    equip: vi.fn(async (item: any) => {
      state.held = item;
    }),
  };
  body.bot = bot;
  body.log = { with: () => ({ info: () => undefined }) };
  body.stopAll = () => {
    throw new Error('守卫不该调用 stopAll');
  };
  body.abortReflexes = () => {
    throw new Error('守卫不该取消反射');
  };
  return body;
}

describe('判定：明显必死才硬拦，边界只提醒', () => {
  it('空手进末地 ⇒ 拒，清单点名"没有武器"（末影人 40 血/4-7 伤害）并给下一步', () => {
    const verdict = departureVerdict(facts({ weapon: null, food: 0, blocks: 10, health: 20 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('拒绝进末地');
    expect(verdict.text).toContain('没有武器');
    expect(verdict.text).toContain('末影人 40 血');
    expect(verdict.text).toContain('下一步（照做即可）');
    expect(verdict.text).toContain('出口/逃跑不受这条限制');
  });

  it('没武器的下一步**必须在空手状态可执行**：4 步链 + 材料账够（2 根原木起，采 3）', () => {
    const verdict = departureVerdict(facts({ weapon: null, food: 20, blocks: 20, health: 20 }));
    expect(verdict.allowed).toBe(false);
    const text = verdict.text ?? '';
    // ① 起点是**徒手**能做的（不是"拿镐挖石头"，那对空手的 bot 是一堵墙）
    expect(text).toContain('collectBlocks(type="oak_log", num=3)');
    expect(text).toContain('徒手');
    expect(text).not.toContain('石剑'); // 石剑要圆石 ⇒ 要木镐 ⇒ 对空手就是墙
    // ② 材料账：1 根原木不够（工作台 4 板 + 剑 4 板 = 8 板 = 2 根）⇒ 回执必须点名
    expect(text).toContain('要 2 根以上');
    // ③ 4 步链每一环都在（模型照抄就能走），木板一次做够
    expect(text).toContain('craft(input="3 oak_log", output="12 oak_planks")');
    expect(text).toContain('craft(input="4 oak_planks", output="1 crafting_table")');
    expect(text).toContain('craft(input="2 oak_planks", output="4 stick")');
    expect(text).toContain('craft(input="2 oak_planks, 1 stick", output="1 wooden_sword")');
    // ④ 3×3 由 craft 自己解决（别再让模型手动放/用工作台——那两步是额外的失败点）
    expect(text).toContain('3×3');
    expect(text).toContain('不用**你手动 `placeHere`');
    expect(text).not.toContain('useBlock(type="crafting_table"');
    // ⑤ 链走完还要回到"去哪"（这条 facts 是 enterEnd ⇒ 就该说 enterEnd）
    expect(text).toContain('然后再 `enterEnd()`');
  });

  it('食物 0 / 方块 10 / 没武器 ⇒ 拒（真机那次的三条同时成立）', () => {
    const verdict = departureVerdict(facts({ weapon: null, food: 0, blocks: 5 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('食物 0');
    expect(verdict.text).toContain('垫脚方块只有 5 个');
  });

  it('食物 9、其它都够 ⇒ **放行 + 响亮提醒**（末地里没有食物来源）', () => {
    const verdict = departureVerdict(facts({ food: 9 }));
    expect(verdict.allowed).toBe(true);
    expect(String(verdict.warning)).toContain('食物只有 9');
    expect(String(verdict.warning)).toContain('没有食物来源');
  });

  it('方块 12（够进但低于建议）⇒ 放行 + 提醒；方块 7 ⇒ 拒', () => {
    expect(departureVerdict(facts({ blocks: 12 })).allowed).toBe(true);
    expect(String(departureVerdict(facts({ blocks: 12 })).warning)).toContain('垫脚方块只有 12 个');
    expect(departureVerdict(facts({ blocks: 7 })).allowed).toBe(false);
  });

  it('血 6 且准备不足 ⇒ 拒；血 10 但其它齐全 ⇒ 放行 + 提醒', () => {
    expect(departureVerdict(facts({ health: 6, food: 0 })).allowed).toBe(false);
    const ok = departureVerdict(facts({ health: 10 }));
    expect(ok.allowed).toBe(true);
    expect(String(ok.warning)).toContain('血量 10');
  });

  it('健康 + 全副武装 ⇒ 什么都不说、什么都不改', () => {
    const verdict = departureVerdict(facts());
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toBeUndefined();
    expect(verdict.text).toBeUndefined();
  });

  it('已经在目标维度 ⇒ 一律放行（这不是"进入"）', () => {
    expect(departureVerdict(facts({ dimension: 'minecraft:the_end', weapon: null, food: 0, blocks: 0 })).allowed).toBe(true);
    expect(departureVerdict(facts({ tool: 'enterNether', dimension: 'minecraft:the_nether', weapon: null, food: 0, blocks: 0 })).allowed).toBe(true);
  });

  it('名单只含进入类工具；武器判定只认剑/斧/三叉戟/弓', () => {
    expect([...DEPARTURE_TOOLS].sort()).toEqual(['enterEnd', 'enterNether']);
    expect(isWeaponName('iron_sword')).toBe(true);
    expect(isWeaponName('stone_axe')).toBe(true);
    expect(isWeaponName('dirt')).toBe(false);
    expect(isWeaponName('shield')).toBe(false);
    expect(targetDimensionOf('enterEnd')).toBe('the_end');
  });
});

describe('身体侧接线：只拦进入、能救就救、拒绝无副作用', () => {
  it('没有武器 ⇒ 拒绝，且不调用 equip、不 stop、不取消反射', async () => {
    const body = departureBody([{ name: 'dirt', count: 10 }], { health: 20, food: 0 });
    const result = await body.departureCheckFor('enterEnd');
    expect(String(result.text)).toContain('拒绝进末地');
    expect(String(result.text)).toContain('没有武器');
    expect(body.bot.equip).not.toHaveBeenCalled();
  });

  it('武器在背包里但没拿在手上 ⇒ **帮它 equip 并放行**（不当成拒绝理由）', async () => {
    const body = departureBody(
      [
        { name: 'iron_sword', count: 1 },
        { name: 'dirt', count: 32 },
      ],
      { health: 20, food: 20 },
    );
    const result = await body.departureCheckFor('enterEnd');
    expect(body.bot.equip).toHaveBeenCalledTimes(1);
    expect(result.text).toBeNull();
  });

  it('食物 9 ⇒ 放行但带提醒（会被追加进回执）', async () => {
    const body = departureBody(
      [
        { name: 'iron_sword', count: 1 },
        { name: 'dirt', count: 32 },
      ],
      { health: 20, food: 9 },
    );
    const result = await body.departureCheckFor('enterEnd');
    expect(result.text).toBeNull();
    expect(String(result.warning)).toContain('食物只有 9');
  });

  it('已经在末地 ⇒ 不检查、不放行日志、不 equip（里面的人绝不被困住）', async () => {
    const body = departureBody([], { dimension: 'minecraft:the_end', health: 3, food: 0 });
    const result = await body.departureCheckFor('enterEnd');
    expect(result.text).toBeNull();
    expect(body.bot.equip).not.toHaveBeenCalled();
  });

  it('出口/其它工具根本不进这道门', async () => {
    const body = departureBody([], { health: 1, food: 0 });
    for (const tool of ['returnFromEnd', 'moveAway', 'consume', 'attack', 'goToCoordinates']) {
      expect((await body.departureCheckFor(tool)).text).toBeNull();
    }
  });

  it('健康 + 全副武装 ⇒ enterEnd 照旧通过，不多余 equip', async () => {
    const body = departureBody(
      [
        { name: 'iron_sword', count: 1 },
        { name: 'dirt', count: 32 },
      ],
      { health: 20, food: 20, held: { name: 'iron_sword' } },
    );
    const result = await body.departureCheckFor('enterEnd');
    expect(result.text).toBeNull();
    expect(body.bot.equip).not.toHaveBeenCalled();
  });

  it('背包/维度读不到 ⇒ 放行（守卫坏了不许把人困住）', async () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.bot = {
      get inventory() {
        throw new Error('boom');
      },
      game: {},
      health: 3,
      food: 0,
    };
    body.log = { with: () => ({ info: () => undefined }) };
    expect((await body.departureCheckFor('enterEnd')).text).toBeNull();
  });
});

describe('提醒不许长得像拒绝、也不许挤掉动作（Lead 2026-10-19 的担心）', () => {
  it('提醒里明确写"这只是提醒，不是拒绝"', () => {
    const verdict = departureVerdict(facts({ food: 9 }));
    expect(String(verdict.warning)).toContain('这只是提醒，不是拒绝');
    expect(String(verdict.warning)).toContain('已经放行');
  });

  it('提醒追加在回执**末尾**：第一行仍然是"放行 + 实际发生了什么"', () => {
    const receipt = '进入末地：走了 12 步，已在主岛。\n    （走到 (74,35,-31)）';
    const annotated = annotateReceipt(receipt, '（**这只是提醒，不是拒绝**）⚠️ 你食物只有 9');
    const lines = annotated.split('\n');
    expect(lines[0]).toContain('进入末地');
    expect(lines[0]).not.toContain('提醒');
    expect(annotated.trimEnd().endsWith('你食物只有 9')).toBe(true);
  });

  it('没有提醒时回执一字不改（不许无端加噪音）', () => {
    expect(annotateReceipt('进入末地：完成。', null)).toBe('进入末地：完成。');
    expect(annotateReceipt('进入末地：完成。', '')).toBe('进入末地：完成。');
  });

  it('准备齐全 ⇒ 连 warning 字段都不出现（零噪音）', () => {
    const verdict = departureVerdict(facts());
    expect(verdict.warning).toBeUndefined();
  });
});
