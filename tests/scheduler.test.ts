/**
 * 动作通道仲裁 + 紧急锁。
 *
 * **事件分发的契约不在这里**——那条线搬到了 `runtime_events.test.ts`
 * （`EventIntake`：事件类型 → 处理、等级只管投递力度）。
 * 这里只剩两条独立线的仲裁：同一时刻最多一个占用型动作；L5 的身体侧反射
 * 在跑时锁住通道，不许模型的动作插进来。
 */
import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/brain/scheduler.js';

describe('动作通道：一次一个', () => {
  it('第二个动作被拒，不排队也不顶替', () => {
    const s = new Scheduler();
    expect(s.startAction('a').accepted).toBe(true);
    expect(s.startAction('b')).toMatchObject({ accepted: false, code: 'ACTION_BUSY' });
    expect(s.currentAction()?.id).toBe('a');
  });

  it('Stop 让出通道并让旧代失效', () => {
    const s = new Scheduler();
    const gen = s.startAction('a').generation ?? 0;
    expect(s.isCurrent(gen)).toBe(true);
    expect(s.stopAll()).toMatchObject({ hadAction: true, actionId: 'a' });
    expect(s.currentAction()).toBeNull();
    expect(s.isCurrent(gen)).toBe(false);
  });

  it('releaseAction 不动 generation：自然结束不是"陌生人"', () => {
    const s = new Scheduler();
    const gen = s.startAction('a').generation ?? 0;
    expect(s.releaseAction()).toBe(true);
    expect(s.currentAction()).toBeNull();
    expect(s.isCurrent(gen)).toBe(true);
  });

  it('currentAction 带 generation，busy 日志能说清是谁/多久', () => {
    const s = new Scheduler();
    s.startAction('digDown');
    const current = s.currentAction();
    expect(current?.id).toBe('digDown');
    expect(current?.generation).toBe(s.describe().generation);
    expect(typeof current?.startedAt).toBe('number');
  });

  it('Stop 与保命急停记录不同的失效原因', () => {
    const s = new Scheduler();
    s.startAction('a');
    s.stopAll();
    expect(s.lastInvalidationReason()).toBe('stop');
    s.startAction('b');
    s.beginEmergency();
    expect(s.lastInvalidationReason()).toBe('emergency');
  });
});

describe('紧急锁（L5 的反射）', () => {
  it('上锁时把正在跑的动作作废，并拒绝新动作', () => {
    const s = new Scheduler();
    const gen = s.startAction('mineBlock').generation ?? 0;
    s.beginEmergency();
    expect(s.locked).toBe(true);
    expect(s.currentAction()).toBeNull();
    expect(s.isCurrent(gen)).toBe(false);
    expect(s.startAction('moveBy')).toMatchObject({ accepted: false, code: 'EMERGENCY_LOCKED' });
  });

  it('解锁后动作可以照常认领', () => {
    const s = new Scheduler();
    s.beginEmergency();
    s.endEmergency();
    expect(s.locked).toBe(false);
    expect(s.startAction('moveBy').accepted).toBe(true);
  });

  it('重复上锁是幂等的（第二次不该再作废一代）', () => {
    const s = new Scheduler();
    s.beginEmergency();
    const gen = s.describe().generation;
    s.beginEmergency();
    expect(s.describe().generation).toBe(gen);
  });

  it('describe 报告通道、代与锁', () => {
    const s = new Scheduler();
    expect(s.describe()).toMatchObject({ actionId: null, emergency: false });
    s.startAction('a');
    s.beginEmergency();
    expect(s.describe()).toMatchObject({ actionId: null, emergency: true });
  });

  it('**Stop 也解锁**：保命反射一直重新触发时，Stop 必须真的把通道还回来', () => {
    // 真机 17:15（overnight_b）：紧急锁一直开着，Stop 回 {"stopped":true} 而
    // 通道仍被锁（快照还写着 escape（已 102s）），stairUp/restart/
    // disableSafeguards 全被拒。
    const s = new Scheduler();
    s.beginEmergency();
    expect(s.startAction('moveBy')).toMatchObject({ accepted: false, code: 'EMERGENCY_LOCKED' });

    s.stopAll();
    expect(s.locked).toBe(false);
    expect(s.startAction('moveBy').accepted).toBe(true);
  });

  it('Stop 解锁之后，真正的危险还会重新上锁（不是把保命关掉）', () => {
    const s = new Scheduler();
    s.beginEmergency();
    s.stopAll();
    s.beginEmergency();
    expect(s.locked).toBe(true);
    expect(s.startAction('moveBy')).toMatchObject({ accepted: false, code: 'EMERGENCY_LOCKED' });
  });

  it('模型的自救动作（escapeWater/consume）穿过紧急锁并解锁（真机 17:59 溺水）', () => {
    // 溺水时 surface 反射与模型调的 escapeWater 互相抢，escapeWater 每次都被
    // EMERGENCY_LOCKED 拒掉，十几轮没上岸，最后淹死。
    const s = new Scheduler();
    s.beginEmergency();
    expect(s.startAction('escapeWater', {}).accepted).toBe(true);
    // 顺手解锁：别让身体侧反射和模型继续互相抢。
    expect(s.locked).toBe(false);

    // **`consume` 不在这里**（验证者探针 ①a）：吃饭不是"从水里/岩浆里出来"，
    // 它在锁下会把紧急锁清掉，等于"吃一口就能把保命关掉"，身体侧还会把正在
    // 救命的 surface 打断 25 秒。
    const s2 = new Scheduler();
    s2.beginEmergency();
    expect(s2.startAction('consume', { item_name: 'bread' })).toMatchObject({
      accepted: false,
      code: 'EMERGENCY_LOCKED',
    });
    expect(s2.locked).toBe(true);

    // 带 ! 前缀也一样。
    const s3 = new Scheduler();
    s3.beginEmergency();
    expect(s3.startAction('!escapeWater', {}).accepted).toBe(true);
  });

  it('紧急锁对**普通**动作照旧拦（自救例外没有把锁掏空）', () => {
    const s = new Scheduler();
    s.beginEmergency();
    expect(s.startAction('mineBlock', {})).toMatchObject({ accepted: false, code: 'EMERGENCY_LOCKED' });
    expect(s.locked).toBe(true);
  });
});
