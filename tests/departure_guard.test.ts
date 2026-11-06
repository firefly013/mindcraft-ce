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
  it('空手进末地 ⇒ 拒：不允许进入 + 未授权 op + 缺项事实', () => {
    const verdict = departureVerdict(facts({ weapon: null, food: 0, blocks: 10, health: 20 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('这次想进末地，但准备不足，没有武器，食物只有 0 个。进这个维度需要先拿到');
    expect(verdict.text).toContain('没有武器');
    expect(verdict.text).toContain('这次想进末地，但准备不足，没有武器，食物只有 0 个。进这个维度需要先拿到');
    expect(verdict.text).not.toContain('allowDangerousOps');
    expect(verdict.text).not.toContain('下一步');
  });

  it('没武器时不写合成步骤', () => {
    const verdict = departureVerdict(facts({ weapon: null, food: 20, blocks: 20, health: 20 }));
    expect(verdict.allowed).toBe(false);
    const text = verdict.text ?? '';
    expect(text).toContain('没有武器');
    expect(text).not.toContain('原木');
    expect(text).not.toContain('craft(input=');
    expect(text).not.toContain('然后再 `enterEnd()`');
  });

  it('食物 0 / 方块 10 / 没武器 ⇒ 拒（真机那次的三条同时成立）', () => {
    const verdict = departureVerdict(facts({ weapon: null, food: 0, blocks: 5 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('这次想进末地，但准备不足，没有武器，食物只有 0 个，垫脚方块只有 5 个');
    expect(verdict.text).toContain('这次想进末地，但准备不足，没有武器，食物只有 0 个，垫脚方块只有 5 个');
  });

  it('食物 9、其它都够 ⇒ 放行 + 实测提醒', () => {
    const verdict = departureVerdict(facts({ food: 9 }));
    expect(verdict.allowed).toBe(true);
    expect(String(verdict.warning)).toContain('这次放行了，食物只有 9 个，建议至少 12 个。');
  });

  describe('未知 ≠ 坏（许可问题：未知必须 fail OPEN）', () => {
    it('**食物读不到** ⇒ 放行，只报读不到', () => {
      const verdict = departureVerdict(facts({ food: null }));
      expect(verdict.allowed).toBe(true);
      expect(verdict.text).toBeUndefined();
      expect(String(verdict.warning)).toContain('食物读不到');
      // 绝不能把"读不到"写成"食物 0"（那就是拿未知当坏消息）
      expect(String(verdict.warning)).not.toContain('食物只有 0');
      expect(String(verdict.warning)).not.toContain('食物 0');
    });

    it('**垫脚方块读不到** ⇒ 放行 + 说明（这条本来就是 null 不当理由，钉住它）', () => {
      const verdict = departureVerdict(facts({ blocks: null }));
      expect(verdict.allowed).toBe(true);
      expect(String(verdict.warning)).toContain('垫脚方块读不到');
    });

    it('**血量读不到**（null）⇒ 放行、不加血量相关的坏话', () => {
      const verdict = departureVerdict(facts({ health: null }));
      expect(verdict.allowed).toBe(true);
      expect(String(verdict.warning ?? '')).not.toContain('血量');
    });

    it('反过来：**已知的坏照拦**（未知才放行；食物 2/0 仍然拒）', () => {
      for (const food of [2, 0]) {
        const verdict = departureVerdict(facts({ food }));
        expect(verdict.allowed, `food=${food}`).toBe(false);
        expect(String(verdict.text)).toContain('食物');
      }
    });

    it('食物未知 + 没武器 ⇒ 拒的是**武器**，不是食物（清单里不许出现食物数字）', () => {
      const verdict = departureVerdict(facts({ food: null, weapon: null }));
      expect(verdict.allowed).toBe(false);
      expect(String(verdict.text)).toContain('没有武器');
      expect(String(verdict.text)).not.toContain('食物 0');
      expect(String(verdict.text)).not.toContain('食物**');
    });
  });

  it('方块 12（够进但低于建议）⇒ 放行 + 提醒；方块 7 ⇒ 拒', () => {
    expect(departureVerdict(facts({ blocks: 12 })).allowed).toBe(true);
    expect(String(departureVerdict(facts({ blocks: 12 })).warning)).toContain('这次放行了，垫脚方块只有 12 个，建议至少 16 个。');
    expect(departureVerdict(facts({ blocks: 7 })).allowed).toBe(false);
  });

  it('血 6 且准备不足 ⇒ 拒；血 10 但其它齐全 ⇒ 放行 + 提醒', () => {
    expect(departureVerdict(facts({ health: 6, food: 0 })).allowed).toBe(false);
    const ok = departureVerdict(facts({ health: 10 }));
    expect(ok.allowed).toBe(true);
    expect(String(ok.warning)).toContain('这次放行了，血量只有 10，建议至少 12。');
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
    expect(String(result.text)).toContain('这次想进末地，但准备不足，没有武器，食物只有 0 个。进这个维度需要先拿到');
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
    expect(String(result.warning)).toContain('这次放行了，食物只有 9 个，建议至少 12 个。');
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
    expect(String(verdict.warning)).toContain('这次放行了，食物只有 9 个，建议至少 12 个。');
    expect(String(verdict.warning)).toContain('这次放行了，食物只有 9 个，建议至少 12 个。');
  });

  it('提醒追加在回执**末尾**：第一行仍然是"放行 + 实际发生了什么"', () => {
    const receipt = '进入末地：走了 12 步，已在主岛。\n    （走到 (74,35,-31)）';
  const annotated = annotateReceipt(receipt, '（放行；食物 9（建议 12））');
    const lines = annotated.split('\n');
    expect(lines[0]).toContain('进入末地');
    expect(lines[0]).not.toContain('提醒');
    expect(annotated.trimEnd().endsWith('食物 9（建议 12））')).toBe(true);
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

describe('显式授权（用户 2026-10-30）：默认拒，点头就放', () => {
  it('空手进末地默认拒；authorized=true ⇒ 放行，但把"你赌的是什么"写进 warning', () => {
    const bare = facts({ weapon: null, food: 20, blocks: 20, health: 20 });
    expect(departureVerdict(bare).allowed).toBe(false);

    const allowed = departureVerdict({ ...bare, authorized: true });
    expect(allowed.allowed).toBe(true);
    expect(allowed.warning).toContain('这次你已经授权了 departure_underprepared，所以放行');
    expect(allowed.warning).toContain('没有武器');
  });

  it('准备齐全时 authorized 不制造额外噪音', () => {
    const verdict = departureVerdict({ ...facts(), authorized: true });
    expect(verdict.allowed).toBe(true);
    expect(verdict.warning).toBeUndefined();
  });

  it('拒绝回执里写着确切的授权调用（含 op id，不让模型猜）', () => {
    const text = departureVerdict(facts({ weapon: null })).text ?? '';
    expect(text).toContain('这次想进末地，但准备不足，没有武器。进这个维度需要先拿到 departur');
    expect(text).toContain('departure_underprepared');
  });
});
