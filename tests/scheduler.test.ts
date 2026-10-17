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
});
