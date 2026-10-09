/**
 * 危险操作注册表。
 *
 * ## 为什么要有这张表
 *
 * 机器人默认**不做危险操作**（倒水、倒岩浆、点火、在下界/末地睡觉、进深水），
 * 只有三种例外：**身上着火**、**模型用工具明确授权一段时间**、**我们写死的保命代码**。
 *
 * 但"危险"这件事**不该硬编码进各个工具里**——那样每加一类危险都要改好几处闸门。
 * 所以做成一张表：**加一条记录 = 加一类危险操作**，闸门、回执、事件、测试全都
 * 顺着表走。
 *
 * ## 默认禁止是"白名单式"的
 *
 * 授权里出现**未注册**的 id 一律拒绝（`isAuthorizable`）。这样模型打错字不会
 * 意外解开一道闸。
 */

/** 判定"某个操作在这里到底危不危险"需要的上下文。 */
export interface OpContext {
  /** 规范化过的维度名：`overworld` / `the_nether` / `the_end`。 */
  dimension: string | null;
  /** 身上是不是着着火（着火时碰水是保命，不算危险操作）。 */
  onFire: boolean;
}

export interface DangerousOp {
  id: string;
  /** 人话描述，**直接进拒绝回执**（模型看的就是它）。 */
  what: string;
  /** 为什么危险。模型看了能理解，不是给机器看的。 */
  why: string;
  /**
   * 只在满足条件时才算危险。不给 = 任何地方都危险。
   *
   * 例：睡觉在**下界和末地**才危险（床会炸），主世界睡觉完全正常。
   */
  when?: (ctx: OpContext) => boolean;
}

/** 规范化维度名：`minecraft:the_end` → `the_end`。 */
export function normalizeDimension(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const idx = raw.lastIndexOf(':');
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

/** 床会炸的维度。**下界和末地都会**，不是只有末地。 */
const BED_EXPLODES_IN: readonly string[] = ['the_nether', 'the_end'];

export const DANGEROUS_OPS: readonly DangerousOp[] = Object.freeze([
  {
    id: 'pour_water',
    what: '用桶倒水（放水 / 泼水）',
    why: '你以前在矿洞里倒水把自己淹死过',
  },
  {
    id: 'pour_lava',
    what: '用桶倒岩浆',
    why: '会烧死自己，也会把路堵上',
  },
  {
    id: 'ignite',
    what: '主动点火（打火石）',
    why: '火会烧掉基地和自己；主世界里正经需要点火只有"点地狱门"那一次',
  },
  {
    id: 'sleep_in_bed',
    what: '上床睡觉',
    // 床在**下界和末地都会炸**；末地那个能一下把人秒了。所以按维度判定。
    why: '下界和末地的床会炸，末地那个能把你秒了',
    when: (ctx) => ctx.dimension != null && BED_EXPLODES_IN.includes(ctx.dimension),
  },
  {
    id: 'enter_deep_water',
    what: '进入深水 / 向深水寻路',
    why: '会被水冲走，也可能淹死',
  },
]);

/** id → 记录。表很小，直接线性找也行，但这是热点路径（每个动作都要问）。 */
const BY_ID = new Map(DANGEROUS_OPS.map((op) => [op.id, op]));

export function findOp(id: string): DangerousOp | null {
  return BY_ID.get(id) ?? null;
}

/** 这个 id 是不是注册过的危险操作（防打错字）。 */
export function isAuthorizable(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * 这个操作**在当下这个上下文里**是不是危险的。
 *
 * 未注册的 id 一律当成"不是危险操作"——它压根不归这张表管；
 * 授权时用 `isAuthorizable` 挡住打错字就够了。
 */
export function isDangerousHere(op: DangerousOp, ctx: OpContext): boolean {
  return op.when == null || op.when(ctx);
}

/** 给模型的拒绝文案：说清**是什么**、**为什么**、**怎么授权**。 */
export function refuseText(op: DangerousOp, minutes = 5): string {
  return (
    `默认不允许${op.what}（${op.why}）。` +
    `要做得先授权：allowDangerousOps(${minutes}, "原因")` +
    `——只想开这一项就写 allowDangerousOps(${minutes}, "原因", "${op.id}")。`
  );
}

export default { DANGEROUS_OPS, findOp, isAuthorizable, isDangerousHere, normalizeDimension, refuseText };
