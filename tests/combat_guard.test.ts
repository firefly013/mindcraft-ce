/**
 * 重伤撤退守卫 —— 真机 2026-10-19（overnight_b，下界第 8 次死亡）。
 *
 * 现场：血 **1.53**、食物 4，模型正在 `attack(target=357368)`。反射只在挨打之后
 * 才接管，**拦不住"濒死时主动选择开打"**；而"attack 成功"的回执让它以为一切正常。
 *
 * 守卫只做一件事：**别让模型把命押在一次进攻上**。它不是锁——吃、getFood、
 * moveAway、垫方块、逃生反射全部照旧可用。
 */
import { describe, expect, it } from 'vitest';
import { OFFENSIVE_TOOL_NAMES, combatRefusalVerdict } from '../src/body/safety/reflex_override.js';
import { MineflayerBody } from '../src/body/mineflayer_body.js';

const facts = (over: Partial<Parameters<typeof combatRefusalVerdict>[0]> = {}) => ({
  health: 20,
  food: 20,
  hostileMeters: null,
  ...over,
});

describe('判定：濒死不许进攻，其它一律放行', () => {
  it('血 1.53 + attack ⇒ 拒，理由点名血量/食物，但不排下一步（真机现场）', () => {
    const verdict = combatRefusalVerdict(facts({ health: 1.53, food: 4, hostileMeters: 4 }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.text).toContain('拒绝');
    expect(verdict.text).toContain('1.53 血');
    expect(verdict.text).toContain('食物 4');
    // 2026-10-30 用户裁定：先脱战还是先吃、怎么打，是模型自己的判断——
    // 回执只留一条**唯一出口**：显式授权这一次。
    expect(verdict.text).toContain('attack_at_low_health');
    expect(verdict.text).toContain('allowDangerousOps');
    expect(verdict.text).not.toContain('下一步（照做即可）');
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

  it('拒的时候**必须**说清逃生/吃都还能用（不是锁），且不提供送死建议', () => {
    const text = combatRefusalVerdict(facts({ health: 2, food: 0 })).text;
    expect(text).toContain('逃跑');
    expect(text).toContain('保命反射都不受这条限制');
    expect(text).not.toContain('故意死');
    expect(text).not.toContain('主动死');
    expect(text).not.toContain('重生');
  });

  it('没有食物也脱不了战 ⇒ 只报"背包里没有能吃的"这个事实', () => {
    const text = combatRefusalVerdict(facts({ health: 1, food: 0 })).text;
    expect(text).toContain('背包里没有能吃的');
    expect(text).not.toContain('keepInventory');
  });

  it('血量读不到 ⇒ 放行（不拿"读不到"当理由拦人）', () => {
    expect(combatRefusalVerdict(facts({ health: null })).allowed).toBe(true);
  });

  // **2026-10-24 修**：目标不会还手就不拦。真机死锁——血 3、食物 11（<18 不回血）、
  // 猪在 4 格外，守卫把 `huntFor` 拒了 ⇒ 低血时唯一的回血路被封死。
  // 危险来自"被反击"，不是"发起攻击"这个动作本身。
  it('打不会还手的猪（targetFightsBack=false）⇒ 濒死也放行', () => {
    const verdict = combatRefusalVerdict(facts({ health: 3, food: 11, targetFightsBack: false }));
    expect(verdict.allowed).toBe(true);
    expect(verdict.text).toBe('');
  });

  it('目标性质读不到（null）⇒ 照旧拦（fail-closed，不猜）', () => {
    expect(combatRefusalVerdict(facts({ health: 3, food: 11, targetFightsBack: null })).allowed).toBe(false);
    // 没传这个字段的老调用方也一样
    expect(combatRefusalVerdict({ health: 3, food: 11, hostileMeters: null }).allowed).toBe(false);
  });

  it('会还手的（僵尸/玩家）⇒ 照旧拦', () => {
    expect(combatRefusalVerdict(facts({ health: 3, food: 11, targetFightsBack: true })).allowed).toBe(false);
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

  it('**打不还手的猪不拦**：huntFor(entity="pig") 濒死也放行，僵尸照拦', () => {
    // bot.entities 里没有猪 ⇒ 守卫要能从 entity 参数名判断
    const body = bareBody(3, 11);
    expect(body.criticalHealthRefusalFor('huntFor', { entity: 'pig' })).toBeNull();
    expect(String(body.criticalHealthRefusalFor('huntFor', { entity: 'zombie' }))).toContain('拒绝');
    expect(body.criticalHealthRefusalFor('attack', { target: 'pig', type: 'mob' })).toBeNull();
    // type=id 时按实体表里的名字判断
    const withPig = bareBody(3, 11, {});
    withPig.bot.entities['15'] = { id: 15, name: 'pig', position: { x: 2, y: 64, z: 0 }, metadata: [] };
    expect(withPig.criticalHealthRefusalFor('attack', { target: '15', type: 'id' })).toBeNull();
    // 玩家默认会还手 ⇒ 照拦
    expect(String(withPig.criticalHealthRefusalFor('attack', { target: 'Notch', type: 'player' }))).toContain('拒绝');
    // 读不到目标性质 ⇒ fail-closed
    expect(String(body.criticalHealthRefusalFor('huntFor'))).toContain('拒绝');
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
  it('背包里有食物 ⇒ 点名有哪些能吃的，但不指挥它先吃', () => {
    const text = combatRefusalVerdict(facts({ health: 1.5, food: 4, foodItems: ['cooked_beef', 'bread'] })).text;
    expect(text).toContain('你背包里有能吃的');
    expect(text).toContain('cooked_beef');
    // 不替它排顺序、也不指定吃哪一样
    expect(text).not.toContain('先吃它');
    expect(text).not.toContain('consume(item_name=');
    expect(text).not.toContain('背包里没有能吃的');
  });

  it('背包里没有食物 ⇒ 只报这条事实，不提供任何送死选项', () => {
    const text = combatRefusalVerdict(facts({ health: 1.5, food: 4, foodItems: [] })).text;
    expect(text).toContain('背包里没有能吃的');
    expect(text).not.toContain('你背包里有能吃的');
    expect(text).not.toContain('死亡');
    expect(text).not.toContain('重生');
  });

  it('食物名列表为空/null/脏数据都不会崩，且退回"没食物"的措辞', () => {
    for (const value of [null, undefined, [], [''], ['']]) {
      const verdict = combatRefusalVerdict(facts({ health: 2, food: 1, foodItems: value as any }));
      expect(verdict.allowed).toBe(false);
      expect(verdict.text).toContain('背包里没有能吃的');
    }
  });
});

describe('显式授权（用户 2026-10-30）：默认拒，点头就放', () => {
  it('低血 + 还手目标默认拒；authorized=true 放行（不再看血量和食物）', () => {
    const base = { health: 1.5, food: 4, targetFightsBack: true as boolean | null };
    expect(combatRefusalVerdict(facts(base)).allowed).toBe(false);
    expect(combatRefusalVerdict(facts({ ...base, authorized: true })).allowed).toBe(true);
  });

  it('不还手的目标仍然免授权（那条是基于事实的豁免，不是授权）', () => {
    const verdict = combatRefusalVerdict(facts({ health: 1.5, food: 4, targetFightsBack: false }));
    expect(verdict.allowed).toBe(true);
  });

  it('拒绝回执里写着确切的授权调用（参数名错了就白费一回合）', () => {
    const text = combatRefusalVerdict(facts({ health: 2, food: 3 })).text;
    expect(text).toContain('allowDangerousOps');
    expect(text).toContain('ops="attack_at_low_health"');
  });
});
