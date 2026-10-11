/**
 * `attack` 的目标解析契约。
 *
 * **type 必填**（`id` / `player` / `mob`），target 的含义全看它——不靠字符串
 * 形状隐式猜。三条路径语义完全平级，没有"默认"也没有"优先"。
 *
 * 两条硬事实撑着这个设计：
 * 1. mineflayer 的玩家实体 `name` 恒为 `'player'`（entities.js:192），身份只在
 *    `username`。按 `name` 找玩家永远落空。
 * 2. 玩家名和怪物类型会同名（曾有个玩家就叫 `zombie`，而 `zombie` 是最常见的
 *    怪物名）。任何"优先匹配某一边"的隐式规则都会在这里猜错。
 *
 * 只用手写 stub，不连真服务器。
 */
import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { resolveAttackTarget } from '../src/agent/library/skills.js';

function stubBot(): Record<string, unknown> {
  const mob = (id: number, name: string, x: number, y: number, z: number) => ({
    id,
    name,
    position: new Vec3(x, y, z),
  });
  return {
    entity: mob(1, 'player', 0, 64, 0),
    entities: {
      1: { ...mob(1, 'player', 0, 64, 0), username: 'me', type: 'player' },
      // 同一类型的两只 zombie：#7 更近，#9 更远。type=mob 必须命中 #7。
      7: mob(7, 'zombie', 3, 64, 0),
      9: mob(9, 'zombie', 5, 64, 0),
      // 玩家：name 是 'player'，身份只在 username
      12: { ...mob(12, 'player', 8, 64, 0), username: 'Notch', type: 'player' },
      20: mob(20, 'item', 2, 64, 0),
    },
  };
}

/** 造一个"有个玩家就叫 zombie"的场景——歧义现场。 */
function stubBotWithZombiePlayer(): Record<string, unknown> {
  const bot = stubBot() as { entities: Record<string, unknown> };
  (bot.entities as Record<string, unknown>)[30] = {
    id: 30,
    name: 'player',
    username: 'zombie',
    type: 'player',
    position: new Vec3(20, 64, 0), // 比 #7 那只真僵尸远得多
  };
  return bot;
}

describe('resolveAttackTarget', () => {
  describe('type=id', () => {
    it('按实体编号命中，且不受"最近优先"影响', () => {
      expect(resolveAttackTarget(stubBot(), '9', 'id').entity?.id).toBe(9);
      expect(resolveAttackTarget(stubBot(), '7', 'id').entity?.id).toBe(7);
    });

    it('能打到玩家', () => {
      const r = resolveAttackTarget(stubBot(), '12', 'id');
      expect(r.entity?.id).toBe(12);
      expect(r.message).toContain('Notch');
    });

    it('不受 64 格感知半径限制（快照里的旧编号仍可走过去）', () => {
      const bot = stubBot() as { entities: Record<string, unknown> };
      (bot.entities as Record<string, unknown>)[40] = {
        id: 40,
        name: 'zombie',
        position: new Vec3(200, 64, 0), // 远超 64 格
      };
      expect(resolveAttackTarget(bot, '40', 'id').entity?.id).toBe(40);
    });

    it('非数字直接报错并说明要编号', () => {
      const bad = resolveAttackTarget(stubBot(), 'Notch', 'id');
      expect(bad.entity).toBeNull();
      expect(bad.message).toContain('纯数字');
    });

    it('不存在的编号给出可自纠的报错，不静默', () => {
      const r = resolveAttackTarget(stubBot(), '999', 'id');
      expect(r.entity).toBeNull();
      expect(r.message).toContain('#999');
    });
  });

  describe('type=player', () => {
    it('按玩家名命中 username，大小写不敏感', () => {
      expect(resolveAttackTarget(stubBot(), 'Notch', 'player').entity?.id).toBe(12);
      expect(resolveAttackTarget(stubBot(), 'notch', 'player').entity?.id).toBe(12);
    });

    it('不会误伤同名怪物（type=player 时只认人）', () => {
      // 场景里有真 zombie #7，但 type=player 不该碰它。
      const r = resolveAttackTarget(stubBotWithZombiePlayer(), 'zombie', 'player');
      expect(r.entity?.id).toBe(30);
      expect(r.entity?.username).toBe('zombie');
    });

    it('附近没有该玩家时明确说找的是玩家', () => {
      const r = resolveAttackTarget(stubBot(), 'zombie', 'player');
      expect(r.entity).toBeNull();
      expect(r.message).toContain('玩家');
    });
  });

  describe('type=mob', () => {
    it('按类型名取最近的那一只', () => {
      // #7 在 3m、#9 在 5m——这是必须有 id 的理由。
      expect(resolveAttackTarget(stubBot(), 'zombie', 'mob').entity?.id).toBe(7);
    });

    it('不会误伤同名玩家（type=mob 时只认怪物）', () => {
      expect(resolveAttackTarget(stubBotWithZombiePlayer(), 'zombie', 'mob').entity?.id).toBe(7);
    });

    it('找不到时列出附近实际有什么（真机报过"找不到 pig 但快照里有"）', () => {
      const r = resolveAttackTarget(stubBot(), 'pig', 'mob');
      expect(r.entity).toBeNull();
      expect(r.message).toContain('zombie');
      expect(r.message).toContain('Notch');
    });
  });

  describe('type 必填', () => {
    it('缺 type 时拒绝执行，并列出全部合法取值', () => {
      const r = resolveAttackTarget(stubBot(), '9', undefined as unknown as string);
      expect(r.entity).toBeNull();
      expect(r.message).toContain('必填');
      for (const t of ['id', 'player', 'mob']) {
        expect(r.message).toContain(t);
      }
    });

    it('空串等同于缺失，不静默降级', () => {
      expect(resolveAttackTarget(stubBot(), '9', '').entity).toBeNull();
    });

    it('非法值不静默降级，且不接受已砍掉的 auto', () => {
      const bad = resolveAttackTarget(stubBot(), '9', 'enemy');
      expect(bad.entity).toBeNull();
      expect(bad.message).toContain('enemy');
      expect(resolveAttackTarget(stubBot(), '9', 'auto').entity).toBeNull();
    });
  });

  describe('空 target', () => {
    it('按type 给出对应的补参提示', () => {
      expect(resolveAttackTarget(stubBot(), '  ', 'id').message).toContain('编号');
      expect(resolveAttackTarget(stubBot(), '  ', 'player').message).toContain('玩家名');
      expect(resolveAttackTarget(stubBot(), '  ', 'mob').message).toContain('实体类型');
    });
  });
});