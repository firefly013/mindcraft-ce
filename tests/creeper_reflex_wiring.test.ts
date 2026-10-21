/**
 * 苦力怕反射必须**真的被身体 tick 调用**（Lead 2026-10-21：「能力存在 ≠ 能力已接通」）。
 * 本测试直接走 MineflayerBody.maybeCreeperReflex（真实接线方法），不测纯函数。
 */
import { describe, expect, it, vi } from 'vitest';
import { MineflayerBody } from '../src/body/mineflayer_body.js';
import { CREEPER_REFLEX_COOLDOWN_MS } from '../src/body/safety/creeper_reflex.js';

function fakeBody(opts: { shield: boolean }): any {
  const body: any = Object.create(MineflayerBody.prototype);
  const pos = { x: 0, y: 64, z: 0 };
  const creepers: any[] = [{ id: 7, name: 'creeper', position: { x: 4, y: 64, z: 0 } }];
  const events: any[] = [];
  const bot: any = {
    health: 20,
    entity: { position: pos },
    entities: { 7: creepers[0] },
    inventory: { items: () => (opts.shield ? [{ name: 'shield', count: 1 }] : []) },
    equip: vi.fn(async () => {}),
    activateItem: vi.fn(),
    deactivateItem: vi.fn(),
    setControlState: vi.fn(),
    lookAt: vi.fn(async () => {
      // 跑出一步后威胁消失（避免测试真等 20 步）
      creepers.length = 0;
      delete bot.entities[7];
    }),
  };
  body.bot = bot;
  body.creeperReflexActive = false;
  body.creeperCooldownUntil = 0;
  body.creeperLastDistance = new Map();
  body.reflexRunning = false;
  body.suffocationRunning = false;
  body.respawnEscapeRunning = false;
  body.shelterHasRoof = () => false;
  body.notify = (_type: string, _kind: unknown, _level: unknown, payload: any) => events.push(payload);
  return { body, bot, events };
}

// 举盾分支最多持有 CREEPER_BLOCK_MAX_MS(2.5s)，episode 结束才清 flag。
const flush = async (ms = 300): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
const waitForEpisode = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 2800));
};

describe('(i) tick 接线：盾分支真的执行', () => {
  it('逼近的苦力怕 + 盾 ⇒ equip+activateItem 被调用，回执报"举盾挡住"', async () => {
    const { body, bot, events } = fakeBody({ shield: true });
    body.maybeCreeperReflex();
    await waitForEpisode();
    expect(bot.equip).toHaveBeenCalled();
    expect(bot.activateItem).toHaveBeenCalled();
    expect(events.some((payload: any) => String(payload?.detail ?? '').includes('举盾挡住'))).toBe(true);
  });
});

describe('(i2) 盾分支在 8 格就开始举盾（不是等到 4 格）', () => {
  it('苦力怕 7.5 格 + 盾 ⇒ 立刻 equip+activateItem，而不是先靠近', async () => {
    const body: any = Object.create(MineflayerBody.prototype);
    const bot: any = {
      health: 20,
      entity: { position: { x: 0, y: 64, z: 0 } },
      entities: { 9: { id: 9, name: 'creeper', position: { x: 7.5, y: 64, z: 0 } } },
      inventory: { items: () => [{ name: 'shield', count: 1 }] },
      equip: vi.fn(async () => {}),
      activateItem: vi.fn(),
      deactivateItem: vi.fn(),
      setControlState: vi.fn(),
      lookAt: vi.fn(async () => {}),
    };
    body.bot = bot;
    body.creeperReflexActive = false;
    body.creeperCooldownUntil = 0;
    body.creeperLastDistance = new Map();
    body.reflexRunning = false;
    body.suffocationRunning = false;
    body.respawnEscapeRunning = false;
    body.shelterHasRoof = () => false;
    body.notify = () => {};
    body.maybeCreeperReflex();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bot.activateItem).toHaveBeenCalled();
    expect(bot.setControlState).not.toHaveBeenCalledWith('forward', true);
  });
});

describe('(ii) 所有权/冷却：结束后释放，不会每 tick 重复', () => {
  it('episode 结束后 flag 清除、冷却写入，下一次 tick 不再行动', async () => {
    const { body, bot } = fakeBody({ shield: true });
    body.maybeCreeperReflex();
    await waitForEpisode();
    expect(body.creeperReflexActive).toBe(false);
    expect(body.creeperCooldownUntil).toBeGreaterThan(Date.now() - 10);
    expect(body.creeperCooldownUntil).toBeLessThanOrEqual(Date.now() + CREEPER_REFLEX_COOLDOWN_MS + 50);
    const callsBefore = bot.equip.mock.calls.length;
    body.maybeCreeperReflex(); // 冷却中
    await flush(120);
    expect(bot.equip.mock.calls.length).toBe(callsBefore);
  });
});

describe('(iii) 无盾分支：真的跑（移动控制被调用），回执照实测说"跑了"', () => {
  it('没盾 ⇒ sprint/forward 被打开，回执含"跑了"、不含"躲过了"', async () => {
    const { body, bot, events } = fakeBody({ shield: false });
    body.maybeCreeperReflex();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(bot.setControlState).toHaveBeenCalledWith('forward', true);
    expect(bot.setControlState).toHaveBeenCalledWith('sprint', true);
    expect(events.some((payload: any) => String(payload?.detail ?? '').includes('跑了'))).toBe(true);
    expect(events.some((payload: any) => String(payload?.detail ?? '').includes('躲过了'))).toBe(false);
  });
});

describe('(iv) 让位：更高优先级反射占用身体 ⇒ 不动', () => {
  it('recoverAfterDeath/重生循环运行中 ⇒ 不 equip、不移动', async () => {
    const { body, bot } = fakeBody({ shield: true });
    body.reflexRunning = true;
    body.maybeCreeperReflex();
    await flush(200);
    expect(bot.equip).not.toHaveBeenCalled();
    expect(body.creeperReflexActive).toBe(false);
  });
});
