/**
 * 危险操作许可的契约。
 *
 * 这套东西的失败模式都很安静（授权没生效、过期没收回、着火豁免漏了），
 * 所以每条规则都钉住。
 */
import { describe, expect, it } from 'vitest';
import {
  DANGEROUS_OPS,
  findOp,
  isAuthorizable,
  isDangerousHere,
  normalizeDimension,
  refuseText,
} from '../src/agent/dangerous_ops.js';
import { FIRE_EXEMPT_OPS, createPermits, opContextFor } from '../src/agent/permits.js';

/** 取一条注册表记录；没注册就直接炸测试（比非空断言清楚）。 */
function op(id: string): (typeof DANGEROUS_OPS)[number] {
  const found = findOp(id);
  if (found == null) throw new Error(`测试要用的危险操作没注册：${id}`);
  return found;
}

const T0 = 1_700_000_000_000;
const dry = { dimension: 'overworld', onFire: false };
const nether = { dimension: 'the_nether', onFire: false };
const burning = { dimension: 'overworld', onFire: true };

describe('危险操作注册表', () => {
  it('规范化维度名（去掉命名空间）', () => {
    expect(normalizeDimension('minecraft:the_end')).toBe('the_end');
    expect(normalizeDimension('the_nether')).toBe('the_nether');
    expect(normalizeDimension('')).toBeNull();
    expect(normalizeDimension(null)).toBeNull();
    expect(normalizeDimension(42)).toBeNull();
  });

  it('床在下界和末地都危险，主世界不危险', () => {
    const bed = op('sleep_in_bed');
    expect(isDangerousHere(bed, dry)).toBe(false);
    expect(isDangerousHere(bed, nether)).toBe(true);
    expect(isDangerousHere(bed, { dimension: 'the_end', onFire: false })).toBe(true);
  });

  it('没写 when 的操作在任何地方都危险', () => {
    for (const id of ['pour_water', 'pour_lava', 'ignite', 'enter_deep_water']) {
      expect(isDangerousHere(op(id), dry)).toBe(true);
    }
  });

  it('未注册的 id 不能授权（防打错字）', () => {
    expect(isAuthorizable('pour_water')).toBe(true);
    expect(isAuthorizable('pour_waterr')).toBe(false);
    expect(isAuthorizable('')).toBe(false);
  });

  it('refuseText 带上"是什么/为什么/怎么授权"', () => {
    const t = refuseText(op('pour_water'), 5);
    expect(t).toContain('倒水');
    expect(t).toContain('allowDangerousOps(5');
    expect(t).toContain('"pour_water"');
  });

  it('每个 op 的 id 唯一', () => {
    const ids = DANGEROUS_OPS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('许可', () => {
  it('默认禁止**所有在这里危险的**操作', () => {
    const p = createPermits();
    for (const op of DANGEROUS_OPS) {
      if (!isDangerousHere(op, dry)) continue; // 这里不危险的本来就不该拦
      expect(p.isAllowed(op.id, dry, T0).allowed).toBe(false);
    }
  });

  it('这里不危险的操作直接放行，不需要授权', () => {
    const p = createPermits();
    const v = p.isAllowed('sleep_in_bed', dry, T0);
    expect(v.allowed).toBe(true);
    expect(v.why).toBe('not-dangerous-here');
  });

  it('授权后放行，到点自动收回', () => {
    const p = createPermits();
    p.grant(null, 5, '浇黑曜石', T0);
    expect(p.isAllowed('pour_water', dry, T0).why).toBe('granted');
    expect(p.isAllowed('pour_water', dry, T0 + 4 * 60_000).allowed).toBe(true);
    // 正好 5 分钟：过期
    expect(p.isAllowed('pour_water', dry, T0 + 5 * 60_000).allowed).toBe(false);
  });

  it('只授权某几项时，其余的仍然禁止', () => {
    const p = createPermits();
    p.grant(['pour_water'], 3, '浇岩浆', T0);
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(true);
    expect(p.isAllowed('pour_lava', dry, T0).allowed).toBe(false);
    expect(p.isAllowed('ignite', dry, T0).allowed).toBe(false);
  });

  it('空数组等同于"全部"（模型不想写清单时的友好处理）', () => {
    const p = createPermits();
    p.grant([], 3, '全部', T0);
    expect(p.isAllowed('pour_lava', dry, T0).allowed).toBe(true);
  });

  it('revoke 立刻收回', () => {
    const p = createPermits();
    p.grant(null, 30, 'x', T0);
    p.revoke();
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(false);
  });

  it('着火豁免"进深水"（灭火），但**不**豁免倒水/倒岩浆/点火/睡觉', () => {
    const p = createPermits();
    expect(FIRE_EXEMPT_OPS).toEqual(['enter_deep_water']);
    const v = p.isAllowed('enter_deep_water', burning, T0);
    expect(v.allowed).toBe(true);
    expect(v.why).toBe('fire');
    // 注意：sleep_in_bed 在主世界本来就不危险，所以这里只测梦里那几项。
    for (const id of ['pour_water', 'pour_lava', 'ignite']) {
      expect(p.isAllowed(id, burning, T0).allowed).toBe(false);
    }
    // 睡觉要放到会炸的维度才算"不豁免"。
    expect(p.isAllowed('sleep_in_bed', { dimension: 'the_end', onFire: true }, T0).allowed).toBe(false);
  });

  it('着火是实时判定：火一灭立刻恢复禁止（不落成授权）', () => {
    const p = createPermits();
    expect(p.isAllowed('enter_deep_water', burning, T0).allowed).toBe(true);
    // 火灭了，同一时刻再问 —— 必须已经禁止。
    expect(p.isAllowed('enter_deep_water', dry, T0).allowed).toBe(false);
    expect(p.current(T0)).toBeNull();
  });

  it('bypassFor 只给某一项发极短的票', () => {
    const p = createPermits();
    p.bypassFor('enter_deep_water', 1000, '溺水自救', T0);
    expect(p.isAllowed('enter_deep_water', dry, T0).why).toBe('bypass');
    expect(p.isAllowed('pour_water', dry, T0).allowed).toBe(false);
    // 过期
    expect(p.isAllowed('enter_deep_water', dry, T0 + 1000).allowed).toBe(false);
  });

  it('未注册 id：闸门放行（不归这张表管）', () => {
    const p = createPermits();
    expect(p.isAllowed('definitely_not_registered', dry, T0).allowed).toBe(true);
  });

  it('describe 说清现状（授权对象/剩余时间/原因）', () => {
    const p = createPermits();
    expect(p.describe(T0)).toContain('没有任何授权');
    p.grant(['ignite'], 2, '点地狱门', T0);
    const text = p.describe(T0 + 30_000);
    expect(text).toContain('ignite');
    expect(text).toContain('点地狱门');
    expect(text).toContain('90 秒');
  });

  it('describe 清掉过期的豁免票——不清的话模型会以为自己还豁免着', () => {
    const p = createPermits();
    p.bypassFor('enter_deep_water', 1000, '溺水自救', T0);
    expect(p.describe(T0)).toContain('内部豁免 1 项');
    const later = p.describe(T0 + 1000);
    expect(later).not.toContain('内部豁免');
    expect(later).toContain('没有任何授权');
  });

  it('describe 也清掉过期的授权（进 Live State 的必须是现在时）', () => {
    const p = createPermits();
    p.grant(null, 1, '浇黑曜石', T0);
    expect(p.describe(T0)).toContain('已授权');
    expect(p.describe(T0 + 60_000)).toContain('没有任何授权');
  });
});

describe('opContextFor', () => {
  it('读维度并规范化', () => {
    expect(opContextFor({ game: { dimension: 'minecraft:the_end' } }).dimension).toBe('the_end');
  });

  it('从实体元数据 bit0 读着火（和 edges.ts 同一套判据）', () => {
    expect(opContextFor({ entity: { metadata: [1] } }).onFire).toBe(true);
    expect(opContextFor({ entity: { metadata: [0] } }).onFire).toBe(false);
    expect(opContextFor({ entity: { metadata: [0x1f] } }).onFire).toBe(true);
  });

  it('拿不到实体/元数据时当作没着火，不炸', () => {
    expect(opContextFor(null).onFire).toBe(false);
    expect(opContextFor({}).onFire).toBe(false);
    expect(opContextFor({ entity: {} }).onFire).toBe(false);
    expect(opContextFor({ entity: { metadata: 'x' } }).onFire).toBe(false);
  });
});
