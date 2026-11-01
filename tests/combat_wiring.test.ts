/**
 * 战斗反射必须**真的接在身体心跳上**（Lead 2026-10-21：「能力存在 ≠ 能力已接通」）。
 *
 * 本测试直接调 `MineflayerBody.maybeCombatReflex`（真实接线方法），并检查源码里
 * 的执行路径：抢身体 → custom-pvp → 完成回执带 `completes`（否则大脑的动作通道
 * 会永久锁死）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MineflayerBody } from '../src/body/mineflayer_body.js';
import settings from '../src/shared/settings.js';

const source = readFileSync(resolve(process.cwd(), 'src/body/mineflayer_body.ts'), 'utf8');

function fakeBody(over: { health?: number; food?: number; entities?: Record<string, any> } = {}): any {
  const body: any = Object.create(MineflayerBody.prototype);
  const pos = { x: 0, y: 64, z: 0 };
  const events: Array<{ type: string; payload: any; extra: any }> = [];
  const bot: any = {
    health: over.health ?? 20,
    food: over.food ?? 20,
    foodSaturation: 5,
    game: { difficulty: 3 },
    entity: { position: pos, id: 99, isInWater: false, onGround: true, effects: {} },
    inventory: {
      items: () => [{ name: 'iron_sword' }, { name: 'bread' }],
      slots: [],
    },
    registry: { entitiesByName: { zombie: { metadataKeys: ['health'] } } },
    entities: over.entities ?? {
      7: {
        id: 7,
        name: 'zombie',
        type: 'hostile',
        position: { x: 3, y: 64, z: 0 },
        yaw: Math.PI / 2,
        attributes: { 'generic.max_health': { value: 20 }, 'generic.attack_damage': { value: 4 } },
        metadata: [20],
      },
    },
  };
  body.bot = bot;
  body.shuttingDown = false;
  body.combatReflexActive = false;
  body.combatCooldownUntil = 0;
  body.combatLastAttackerName = 'zombie';
  body.combatShadowAt = 0;
  body.reflexRunning = false;
  body.reflexQueue = [];
  body.suffocationRunning = false;
  body.respawnEscapeRunning = false;
  body.creeperReflexActive = false;
  body.modelActionRequested = false;
  body.currentReflexName = null;
  body.currentReflexIntent = null;
  body.currentReflexStartedAt = 0;
  body.notify = (type: string, _kind: unknown, _level: unknown, payload: any, extra: any = {}) => {
    events.push({ type, payload, extra });
  };
  body.emergency = vi.fn();
  body.performCombatEngage = vi.fn(async () => {});
  return { body, bot, events };
}

describe('(i) 接线：遇怪接管', () => {
  beforeEach(() => {
    (settings as any).combatPolicy = { mode: 'on', margin: 1.6, exitMargin: 1.0, scanRadius: 24, maxEngageMs: 20_000 };
  });
  afterEach(() => {
    delete (settings as any).combatPolicy;
  });

  it('僵尸贴脸 ⇒ 启动交战（performCombatEngage 被调用）', () => {
    const { body } = fakeBody();
    body.maybeCombatReflex();
    expect(body.performCombatEngage).toHaveBeenCalledTimes(1);
    expect(body.performCombatEngage.mock.calls[0][0]).toBe(7);
  });

  it('打不过 ⇒ 交给 escape 反射（不自己打）', () => {
    const { body } = fakeBody({ health: 4, food: 8 });
    body.maybeCombatReflex();
    expect(body.performCombatEngage).not.toHaveBeenCalled();
    expect(body.emergency).toHaveBeenCalledWith(
      'combat.flee',
      expect.anything(),
      'escape',
      'flee',
    );
  });

  it('shadow 模式只写回执、不动身体', () => {
    (settings as any).combatPolicy = { mode: 'shadow', margin: 1.6, exitMargin: 1.0, scanRadius: 24, maxEngageMs: 20_000 };
    const { body, events } = fakeBody();
    body.maybeCombatReflex();
    expect(body.performCombatEngage).not.toHaveBeenCalled();
    expect(body.emergency).not.toHaveBeenCalled();
    const shadow = events.find((e: { type: string; payload?: any }) => e.type === 'combat.shadow');
    expect(shadow).toBeTruthy();
    expect(String(shadow?.payload?.detail ?? '')).toContain('判决');
  });

  it('模式 off ⇒ 完全不动', () => {
    (settings as any).combatPolicy = { mode: 'off' };
    const { body } = fakeBody();
    body.maybeCombatReflex();
    expect(body.performCombatEngage).not.toHaveBeenCalled();
    expect(body.emergency).not.toHaveBeenCalled();
  });

  it('苦力怕反射在跑 ⇒ 战斗反射让位', () => {
    const { body } = fakeBody();
    body.creeperReflexActive = true;
    body.maybeCombatReflex();
    expect(body.performCombatEngage).not.toHaveBeenCalled();
  });

  it('保命反射在跑 ⇒ 战斗反射让位', () => {
    const { body } = fakeBody();
    body.reflexRunning = true;
    body.maybeCombatReflex();
    expect(body.performCombatEngage).not.toHaveBeenCalled();
  });

  it('冷却中 ⇒ 不立刻再开一场', () => {
    const { body } = fakeBody();
    body.combatCooldownUntil = Date.now() + 5_000;
    body.maybeCombatReflex();
    expect(body.performCombatEngage).not.toHaveBeenCalled();
  });
});

describe('(ii) 源码接线：心跳、抢身体、完成回执', () => {
  it('update() 里真的调用了战斗反射（紧挨苦力怕反射之后）', () => {
    expect(source).toContain('this.maybeCombatReflex();');
    const creeperAt = source.indexOf('this.maybeCreeperReflex();');
    const combatAt = source.indexOf('this.maybeCombatReflex();');
    expect(creeperAt).toBeGreaterThan(0);
    expect(combatAt).toBeGreaterThan(creeperAt);
  });

  it('执行走 custom-pvp（attackEntity），不是自己挥刀', () => {
    expect(source).toContain('attackEntity');
    expect(source).toContain('performCombatEngage');
  });

  it('接管时发 L5 事件并声明 reflex；完成时带 completes 解锁大脑通道', () => {
    expect(source).toContain("'combat.engage'");
    expect(source).toContain("completes: 'combat'");
  });

  it('策略从 settings.combatPolicy 读，且没有自建轮询定时器', () => {
    expect(source).toContain('readCombatPolicy(settings.combatPolicy)');
    expect(source).not.toMatch(/setInterval\s*\(\s*\(?\)?\s*=>\s*\{?\s*this\.maybeCombatReflex/);
  });

  it('模型的动作被打断时留下"谁抢的"（__interruptReason）', () => {
    expect(source).toContain('战斗反射 combat 接管');
  });

  it('Stop / 模型自救能打断交战（abortReflexes 认识 combatReflexActive）', () => {
    expect(source).toContain('const combat = this.combatReflexActive === true;');
  });
});
