/**
 * 拾取几何 + 轨迹 —— 真机 2026-10-19（overnight_a 请求干预）。
 *
 * verbatim：「掉落物在 0.9m 同层第 6 次捡不到；move 方向反；jump 无效」，
 * 以及「容器坏 7 次 + 掉落物捡不到 7 次 + 背包清空 4 次」——A 侧完全没有获取物品的手段。
 *
 * 两个问题必须分开回答：
 *   ① 服务端是否**本该**判定可拾取？（原版规则：掉落物包围盒与玩家包围盒
 *      "水平各扩 1 格、垂直各扩 0.5 格"后相交，不是"脚底距离 < 1"）
 *   ② bot 到底**动没动**？（"move 方向反 / jump 无效"会让每次靠近都是空操作）
 */
import { describe, expect, it } from 'vitest';
import { pickupOverlapVerdict, shouldBypassThreatGateForPickup, summarizePickupTrace } from '../src/body/auto_pickup.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const botAt = (x: number, y: number, z: number, height = 1.8) => ({ x, y, z, height });

describe('pickupOverlapVerdict：按原版包围盒规则判断"该不该能捡"', () => {
  it('同层 0.9 米（A 的现场）⇒ 相交，服务端应当允许拾取', () => {
    const verdict = pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0.9, y: 64.2, z: 0 } });
    expect(verdict.overlap).toBe(true);
    expect(verdict.reason).toContain('包围盒相交');
  });

  it('水平 1.9 米 ⇒ 不相交；1.5 米（扩 1 格内）⇒ 相交', () => {
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 1.9, y: 64.2, z: 0 } }).overlap).toBe(false);
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 1.5, y: 64.2, z: 0 } }).overlap).toBe(true);
  });

  it('掉落物在头顶 3 米（隔着楼层也别指望）⇒ 不相交', () => {
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0, y: 67.5, z: 0 } }).overlap).toBe(false);
  });

  it('垂直容差：脚下 0.5 米内仍算相交（掉落物掉在脚边）', () => {
    expect(pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0, y: 63.6, z: 0 } }).overlap).toBe(true);
  });

  it('不同 y 层但水平很近、且超出垂直容差 ⇒ 不相交（"同层"必须是真同层）', () => {
    const verdict = pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0.2, y: 62.0, z: 0.2 } });
    expect(verdict.overlap).toBe(false);
    expect(verdict.reason).toContain('不相交');
  });
});

describe('summarizePickupTrace：bot 动没动 / 有没有真的靠近', () => {
  it('bot 几乎没动 ⇒ 明说"靠近这一步没生效"（对应 A 的"move 方向反"）', () => {
    const summary = summarizePickupTrace([
      { botMoved: 0, dx: 0.9, dy: 0.2, dz: 0, overlap: true },
      { botMoved: 0.01, dx: 0.9, dy: 0.2, dz: 0, overlap: true },
    ]);
    expect(summary.botTravel).toBeLessThan(0.2);
    expect(summary.note).toContain('几乎没动');
    expect(summary.overlapEver).toBe(true);
    expect(summary.note).toContain('几何上早该能捡');
  });

  it('从未相交 ⇒ 明说"一直没真正靠近到可拾取范围"', () => {
    const summary = summarizePickupTrace([
      { botMoved: 0.5, dx: 3, dy: 0, dz: 0, overlap: false },
      { botMoved: 0.6, dx: 2.2, dy: 0, dz: 0, overlap: false },
    ]);
    expect(summary.overlapEver).toBe(false);
    expect(summary.note).toContain('从未出现过包围盒相交');
    expect(summary.note).toContain('移动了');
  });

  it('给最近距离（用于回执里说清"差多少"）', () => {
    const summary = summarizePickupTrace([
      { botMoved: 0.4, dx: 3, dy: 1, dz: 0, overlap: false },
      { botMoved: 0.4, dx: 0.4, dy: 0.1, dz: 0.2, overlap: true },
    ]);
    expect(summary.closest?.dx).toBeCloseTo(0.4);
    expect(summary.samples).toBe(2);
  });

  it('没采到轨迹（掉落物已消失）⇒ 如实说，不编造"没动"', () => {
    const summary = summarizePickupTrace([]);
    expect(summary.samples).toBe(0);
    expect(summary.note).toContain('没有采到轨迹');
  });

  it('接线：拾取路径真的会采轨迹、并且失败时把摘要写进回执（源码守卫）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain("event: 'pickup-trace'");
    expect(src).toContain('summarizePickupTrace(traceSamples)');
    expect(src).toContain('拾取轨迹：');
    expect(src).toContain('setInterval(sampleTrace, 250)');
  });
});

describe('掉落物"出现了但没人去捡"要能分开（真机 2026-10-19 骷髅击杀）', () => {
  it('源码守卫：掉落物出现时记 drop-seen（id/距离/是否会去捡/被什么挡住）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain("event: 'drop-seen'");
    expect(src).toContain('willAttempt');
    expect(src).toContain('blockedBy');
    // 常见闸门都要能被点名，否则日志还是说不清"为什么没去捡"
    for (const reason of ['背包未同步', '退避中', '保命后静默期', '反射在跑', '模型动作占用身体', '附近有敌对生物']) {
      expect(src).toContain(reason);
    }
  });

  it('四条事实互不等价：实体存在 ≠ 重叠 ≠ 入包（用现有判定函数分别表达）', () => {
    // (b) 实体存在：由 item.drop.nearby / drop-seen 记录
    // (c) 是否重叠过：
    const overlapped = pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0.9, y: 64, z: 0 } });
    expect(overlapped.overlap).toBe(true);
    const neverReached = pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 3.5, y: 64, z: 0 } });
    expect(neverReached.overlap).toBe(false);
    // (d) 入包与否：由 summarizePickupTrace / inventory 增量表达（此处只需证明两者可以不一致）
    const trace = summarizePickupTrace([{ botMoved: 1.2, dx: 0.9, dy: 0, dz: 0, overlap: true }]);
    expect(trace.overlapEver).toBe(true);
    expect(trace.note).toContain('几何上早该能捡');
  });
});

describe('击杀后的拾取优先窗口（有界 + 挨打就让位）', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    now: 10_000,
    priorityUntil: 0,
    lastHurtAt: 0,
    ...over,
  });

  it('窗口内且没挨打 ⇒ 绕过"附近有怪"闸门（刚打完怪正是要捡战利品）', () => {
    expect(shouldBypassThreatGateForPickup(input({ priorityUntil: 15_000 }))).toBe(true);
  });

  it('窗口过期 ⇒ 不绕过（有界）', () => {
    expect(shouldBypassThreatGateForPickup(input({ priorityUntil: 9_999 }))).toBe(false);
    expect(shouldBypassThreatGateForPickup(input({ priorityUntil: 10_000 }))).toBe(false);
  });

  it('**正在挨打 ⇒ 不绕过**（保命优先于捡东西）', () => {
    expect(shouldBypassThreatGateForPickup(input({ priorityUntil: 15_000, lastHurtAt: 9_500 }))).toBe(false);
    expect(shouldBypassThreatGateForPickup(input({ priorityUntil: 15_000, lastHurtAt: 7_000 }))).toBe(true);
  });

  it('接线：击杀确认开 5 秒窗口、有日志、threatNear 走这条判定（源码守卫）', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');
    expect(src).toContain("event: 'pickup-priority-window'");
    expect(src).toContain('this.pickupPriorityUntil = Date.now() + 5_000;');
    expect(src).toContain('shouldBypassThreatGateForPickup({');
    // 四件事分开写给模型：出现/距离/去不去
    expect(src).toContain('【掉落物出现】');
    // progression.ts 侧（feedback-analyst）从 bot.output 取最后一条 `drop-seen{…}`：
    // 标记必须真的存在，否则他们的集成会一直拿到 null。
    expect(src).toContain('drop-seen{id=');
    expect(src).toContain('blockedBy=[');
    expect(src).toContain('它**不代表**你捡到了');
  });
});

describe('优先窗口必须 fail-closed（Lead 修正的回归测试）', () => {
  // `Object.create(MineflayerBody.prototype)` 的 fixture、以及任何没初始化字段的调用方，
  // 传进来的都是 undefined；而 JS 里 `undefined <= 数字` 是 **false**，
  // 用 `<=` 判断会把"没有窗口"读成"窗口开着" ⇒ 僵尸在旁边也去捡东西。
  it('priorityUntil=undefined ⇒ 视为**没有窗口**（不开窗）', () => {
    expect(shouldBypassThreatGateForPickup({ now: 10_000, priorityUntil: undefined as unknown as number, lastHurtAt: 0 })).toBe(false);
  });

  it('priorityUntil=NaN / Infinity / 字符串 ⇒ 一律不开窗', () => {
    expect(shouldBypassThreatGateForPickup({ now: 10_000, priorityUntil: NaN, lastHurtAt: 0 })).toBe(false);
    // Infinity 也不是真实截止时刻（Number.isFinite 为假）⇒ 按 fail-closed 不开窗。
    expect(shouldBypassThreatGateForPickup({ now: 10_000, priorityUntil: Infinity, lastHurtAt: 0 })).toBe(false);
    expect(shouldBypassThreatGateForPickup({ now: 10_000, priorityUntil: 5_000, lastHurtAt: 0 })).toBe(false);
  });

  it('lastHurtAt=undefined ⇒ 视为"没受过伤"（不是"一直在挨打"，也不是"忽略"）', () => {
    // 有窗口 + 受伤时间未知 ⇒ 允许去捡（未知不代表正在挨打）
    expect(shouldBypassThreatGateForPickup({ now: 10_000, priorityUntil: 15_000, lastHurtAt: undefined as unknown as number })).toBe(true);
    // 有窗口 + 明确刚挨打 ⇒ 不让位
    expect(shouldBypassThreatGateForPickup({ now: 10_000, priorityUntil: 15_000, lastHurtAt: 9_000 })).toBe(false);
  });

  it('**方向**：这个判定回答"能不能忽略威胁"，所以缺值一律关门（fail-closed）', () => {
    expect(shouldBypassThreatGateForPickup({ now: 10_000, priorityUntil: undefined as unknown as number, lastHurtAt: undefined as unknown as number })).toBe(false);
  });
});

describe('闸门不许把"测不出来"当成"不要去"（Lead 2026-10-19 裁定 ①）', () => {
  const src = () => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('背包未同步**不再是拦路理由**，只出现在"测量"一栏', () => {
    const code = src();
    // schedulePickup 里不许再有"未同步就直接 return"
    const start = code.indexOf('private schedulePickup');
    const end = code.indexOf('private async walkToPickup');
    const block = code.slice(start, end > start ? end : start + 4000);
    expect(block).not.toContain('if (this.inventorySynced === false) return;');
    // drop-seen 的 blockedBy 里不许再出现"背包未同步"，但 measurement 里要有
    expect(code).toContain('const measurement: string[] = [];');
    expect(code).toContain("measurement.push('背包未同步（捡到了也暂时读不出增量，用 stats 核对）')");
    expect(code).toContain('measurement,');
    // 真机那条真值行必须仍然声称"不是威胁"
    expect(code).toContain('这只影响读数，不阻止去捡');
  });

  it('身体被占用的拾取要在动作收尾重试（有界 + 有日志 + 报告捡到什么）', () => {
    const code = src();
    expect(code).toContain('private async sweepPickupAtActionTail');
    expect(code).toContain("event: 'pickup-tail-sweep'");
    expect(code).toContain('attempted: true');
    expect(code).toContain('collected');
    expect(code).toContain('【收尾清扫】');
    // 有界：1.5 秒预算；且不抢保命反射
    expect(code).toContain('1_500');
    expect(code).toContain('if (this.reflexRunning === true || (this.reflexQueue?.length ?? 0) > 0) return null;');
    // 接线：动作收尾调用
    expect(code).toContain('await this.sweepPickupAtActionTail()');
  });
});

describe('0.2 米还不被捡：先取证，不先打补丁（Lead 2026-10-19）', () => {
  const src = () => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

  it('引擎自己怎么看 0.2 米：按原版包围盒规则**必须**判定为可拾取', () => {
    // 三条 3D 距离 0.2–0.5 的实测样本，同层/略高略低都必须 overlap=true
    for (const dy of [-0.2, 0, 0.2, 0.5]) {
      const verdict = pickupOverlapVerdict({ bot: botAt(0, 64, 0), item: { x: 0.2, y: 64 + dy, z: 0.2 } });
      expect(verdict.overlap).toBe(true);
    }
    // 所以：若服务端仍不吸收，问题**不在**"我们的距离/包围盒规则"
  });

  it('drop-geometry：一次性记录双方 y / dy / 物品 onGround / 脚下方块 / 重叠判定', () => {
    const code = src();
    expect(code).toContain("event: 'drop-geometry'");
    for (const field of ['botY', 'itemY', 'dy', 'itemOnGround', 'underItem', 'overlap', 'overlapReason', 'botOnGround']) {
      expect(code).toContain(`${field}:`);
    }
  });

  it('**清扫不再因为"模型 Stop 的 abort 标记"而放弃**（真机：abort 窗口的掉落物永远没人捡）', () => {
    const code = src();
    const start = code.indexOf('private async sweepPickupAtActionTail');
    const block = code.slice(start, start + 1500);
    expect(block).not.toContain('if (this.pickingUp || this.pickupAbortRequested) return null;');
    // 保命反射仍然让路（这是唯一该放弃的理由）
    expect(block).toContain('if (this.reflexRunning === true || (this.reflexQueue?.length ?? 0) > 0) return null;');
  });

  it('动作结束时清掉粘住的 abort 标记（否则每件掉落物都被判"已被要求中止"）', () => {
    expect(src()).toContain('if (this.reflexRunning !== true) this.pickupAbortRequested = false;');
  });
});
