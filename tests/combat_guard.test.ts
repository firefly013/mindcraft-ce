/**
 * 重伤撤退守卫 —— 真机 2026-10-19（overnight_b，下界第 8 次死亡）。
 *
 * 现场：血 **1.53**、食物 4，模型正在 `attack(target=357368)`。反射只在挨打之后
 * 才接管，**拦不住"濒死时主动选择开打"**；而"attack 成功"的回执让它以为一切正常。
 *
 * 守卫只做一件事：**别让模型把命押在一次进攻上**。它不是锁——吃、getFood、
 * moveAway、垫方块、逃生反射、故意死一次全部照旧可用。
 */
import { describe, expect, it } from 'vitest';
import { OFFENSIVE_TOOL_NAMES, combatRefusalVerdict } from '../src/body/safety/reflex_override.js';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

const facts = (over: Partial<Parameters<typeof combatRefusalVerdict>[0]> = {}) => ({
  health: 20,
  food: 20,
  hostileMeters: null,
  keepInventory: true,
  immediateRespawn: true,
  ...over,
});

describe('判定：濒死不许进攻，其它一律放行', () => {
  it('血 1.53 + attack ⇒ 拒，理由点名血量/食物并给下一步（真机现场）', () => {
    const verdict = combatRefusalVerdict(facts({ health: 1.53, food: 4, hostileMeters: 4 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('拒绝');
    expect(verdict.text).toContain('1.53 血');
    expect(verdict.text).toContain('食物 4');
    expect(verdict.text).toContain('moveAway(distance=16)');
    expect(verdict.text).toContain('下一步（照做即可）');
  });

  it('血 5 + 食物 4（没回血手段）⇒ 拒；血 6 + 食物 20 ⇒ 放行', () => {
    expect(combatRefusalVerdict(facts({ health: 5, food: 4 })).allowed).toBe(false);
    expect(combatRefusalVerdict(facts({ health: 6, food: 20 })).allowed).toBe(true);
  });

  it('血 8 + attack ⇒ 放行（不许过度拦截）', () => {
    expect(combatRefusalVerdict(facts({ health: 8, food: 20 })).allowed).toBe(true);
  });

  it('血 20 ⇒ 什么都不说、什么都不改', () => {
    const verdict = combatRefusalVerdict(facts({ health: 20 }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.text).toBe('');
  });

  it('拒的时候**必须**说清逃生/吃/故意死都还能用（不是锁）', () => {
    const text = combatRefusalVerdict(facts({ health: 2, food: 0 })).text;
    expect(text).toContain('逃跑');
    expect(text).toContain('保命反射都不受这条限制');
    expect(text).toContain('故意死一次是合法选择');
    expect(text).toContain('物品和经验都保留');
  });

  it('没有食物也脱不了战 ⇒ 明确说"死一次是合法重置"（这个存档 keepInventory+立即重生）', () => {
    const text = combatRefusalVerdict(facts({ health: 1, food: 0, keepInventory: true, immediateRespawn: true })).text;
    expect(text).toContain('keepInventory');
    expect(text).toContain('合法');
  });

  it('血量读不到 ⇒ 放行（不拿"读不到"当理由拦人）', () => {
    expect(combatRefusalVerdict(facts({ health: null })).allowed).toBe(true);
  });

  it('只有进攻类工具在这张名单里（逃生/吃/移动不在）', () => {
    expect(OFFENSIVE_TOOL_NAMES.has('attack')).toBe(true);
    expect(OFFENSIVE_TOOL_NAMES.has('huntFor')).toBe(true);
    for (const safe of ['moveAway', 'consume', 'getFood', 'escapeWater', 'placeHere', 'stats', 'goToCoordinates']) {
      expect(OFFENSIVE_TOOL_NAMES.has(safe)).toBe(false);
    }
  });
});

describe('身体侧接线：拒的是进攻，放行的是逃生；而且不打断正在跑的保命反射', () => {
  const bareBody = (health: number, food: number, over: Record<string, unknown> = {}): any => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.bot = {
      health,
      food,
      entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
      entities: {
        9: { id: 9, name: 'zombie', position: { x: 4, y: 64, z: 0 }, metadata: [] },
      },
    };
    Object.assign(body, over);
    return body;
  };

  it('血 1.5、食物 4 ⇒ attack 被拒（返回文本），moveAway/consume/getFood 不受影响', () => {
    const body = bareBody(1.5, 4);
    const refusal = body.criticalHealthRefusalFor('attack');
    expect(String(refusal)).toContain('拒绝');
    expect(String(refusal)).toContain('1.5 血');
    expect(body.criticalHealthRefusalFor('moveAway')).toBeNull();
    expect(body.criticalHealthRefusalFor('consume')).toBeNull();
    expect(body.criticalHealthRefusalFor('getFood')).toBeNull();
    expect(body.criticalHealthRefusalFor('escapeWater')).toBeNull();
    expect(body.criticalHealthRefusalFor('placeHere')).toBeNull();
  });

  it('huntFor 同样被拒；满血时 attack 放行', () => {
    expect(String(bareBody(3, 3).criticalHealthRefusalFor('huntFor'))).toContain('拒绝');
    expect(bareBody(20, 20).criticalHealthRefusalFor('attack')).toBeNull();
  });

  it('拒一次不许留下任何副作用：不 stop、不动 reflex、不改字段', () => {
    const stops: string[] = [];
    const body = bareBody(1.5, 4, {
      reflexStatus: () => ({ reflex: 'escape', intent: 'flee', ms: 3_000 }),
      stopAll: () => stops.push('stopAll'),
      abortReflexes: () => stops.push('abortReflexes'),
      forceStopBody: () => stops.push('forceStopBody'),
    });
    const before = JSON.stringify({ h: body.bot.health, f: body.bot.food });
    const refusal = body.criticalHealthRefusalFor('attack');
    expect(refusal).not.toBeNull();
    // 守卫是纯判定：不许取消正在跑的 escape 反射，也不许动身体
    expect(stops).toEqual([]);
    expect(body.reflexStatus().reflex).toBe('escape');
    expect(JSON.stringify({ h: body.bot.health, f: body.bot.food })).toBe(before);
    expect(String(refusal)).toContain('保命反射都不受这条限制');
  });

  it('读不到血量时守卫自己也不该把人拦住（守卫坏了要放行）', () => {
    const body: any = Object.create(MineflayerBody.prototype);
    body.bot = { health: undefined, food: undefined, entity: { id: 1 }, entities: {} };
    expect(body.criticalHealthRefusalFor('attack')).toBeNull();
  });
});

describe('有食物 vs 没食物：措辞必须不同（防止"有吃的却去送死"这个新失败模式）', () => {
  it('背包里有食物 ⇒ 先让吃它，把"故意死"降级为"实在没别的办法时"', () => {
    const text = combatRefusalVerdict(facts({ health: 1.5, food: 4, foodItems: ['cooked_beef', 'bread'] })).text;
    expect(text).toContain('你背包里有吃的');
    expect(text).toContain('cooked_beef');
    expect(text).toContain('先吃它');
    expect(text).toContain('只有真的没食物');
    expect(text).not.toContain('如果既没有食物也脱不了战');
    expect(text).toContain('consume(item_name="cooked_beef")');
  });

  it('背包里没有食物 ⇒ 才把"故意死一次是合法重置"明说出来', () => {
    const text = combatRefusalVerdict(facts({ health: 1.5, food: 4, foodItems: [] })).text;
    expect(text).toContain('如果既没有食物也脱不了战');
    expect(text).toContain('合法选择');
    expect(text).not.toContain('你背包里有吃的');
  });

  it('食物名列表为空/null/脏数据都不会崩，且退回"没食物"的措辞', () => {
    for (const value of [null, undefined, [], [''], ['']]) {
      const verdict = combatRefusalVerdict(facts({ health: 2, food: 1, foodItems: value as any }));
      expect(verdict.allowed).toBe(false);
      expect(verdict.text).toContain('如果既没有食物也脱不了战');
    }
  });
});
