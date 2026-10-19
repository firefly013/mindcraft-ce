/*
 * 「这个工具不是干这件事的」——**写在回执里**，而且必要时**顶掉最后一行**。
 *
 * 真机（2026-10-19）：overnight_b 要去 380 格外的下界要塞拿烈焰棒，却一遍遍用
 * `mineTunnel`。那个工具**要求调用方自己保证方向**（模型常常没给 direction ⇒ 按朝向猜 ⇒ 挖反），
 * 而 `travelTo` 是按坐标算方向、自己规划腿、续跑也带坐标的。工具说明里已经写了，
 * 但**今晚量出来的事实是：模型跟回执比跟散文说明可靠得多**。
 *
 * **最后一行是"能照抄就能做的调用"**（全晚的硬规矩）。所以当大脑知道目标在 343 格外、
 * 而工具自己给的建议是"再挖一段"时，工具那条**不是**最好的下一步 —— 那就：
 *   ① 把工具自己那条降级成"- 工具自己的建议（**不要照做**）：…"（**留在原地可见**，
 *      而且明确说出被顶掉的是哪一条 —— 悄悄换掉会留下两条互相矛盾的"照抄即可"）；
 *   ② 追加一行说明为什么；
 *   ③ 把 `travelTo(x=…, z=…)` 放成**唯一**的「下一步（照做即可）：…」。
 * 没有要覆盖的时候（用 travelTo、目标很近、读不到位置、有歧义），**回执一个字节都不动**。
 *
 * **目标从哪来**：身体**不知道 goal**（`edges.ts`：目标是大知识，身体不知道也不该知道），
 * 所以这件事只能在大脑侧做——它同时知道 plan（goal/todos）和 places（地名→坐标）。
 * 优先取"计划里提到的地名"；只有一个候选时用它；有歧义就**不猜**（宁可不提醒，也不指错地方）。
 */

/** 少于这么多格就不算"长途"（近处用 mineTunnel 完全合理）。 */
export const LONG_RANGE_MIN_BLOCKS = 96;

/** 回执里「下一步」那一行的前缀（**唯一**允许出现在最后一行的那种）。 */
export const NEXT_CALL_PREFIX = '下一步（照做即可）：';

export interface LongRangeNudgeInput {
  /** 工具名（**不带**前导 `!`，和 `invokeTool` 的口径一致）。 */
  toolName: string;
  /** 现在在哪（水平坐标）；读不到就 null（那就不提醒，不猜）。 */
  here: { x: number; z: number } | null;
  /** 当前计划（goal + todos）的文本：用来判断"要去的是哪个记住的地方"。 */
  planText: string;
  /** 记住的地方：名字 → [x, y, z]。 */
  places: Record<string, [number, number, number]>;
  minDistance?: number;
}

export interface LongRangeTarget {
  name: string;
  x: number;
  z: number;
  distance: number;
}

/** 大脑侧要往回执里加的东西：一行说明 + 一个"应该照做"的调用。 */
export interface ReceiptHint {
  /** 追加的说明行（会插在最后的「下一步」之前）。 */
  note: string;
  /** 要**顶掉**最后一行「下一步」的调用；不填 = 不动最后一行。 */
  nextCall?: string;
}

/**
 * 挑出"计划里那个很远的目标"（纯函数，可单测）。
 *
 * 规则：只在计划文本里**点名**的地名里挑；一个都没点名时，只有**唯一**一个够远的候选才用；
 * 其余情况返回 null（歧义不猜）。
 */
export function pickLongRangeTarget(input: LongRangeNudgeInput): LongRangeTarget | null {
  const minDistance = input.minDistance ?? LONG_RANGE_MIN_BLOCKS;
  if (input.here == null) return null;
  const all: LongRangeTarget[] = [];
  for (const [name, coords] of Object.entries(input.places ?? {})) {
    if (!Array.isArray(coords) || coords.length < 3) continue;
    const x = Number(coords[0]);
    const z = Number(coords[2]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    all.push({ name, x, z, distance: Math.hypot(x - input.here.x, z - input.here.z) });
  }
  // **计划点名的地名说了算**：点了名就只认它 —— 哪怕它很近（那就不提醒），
  // 绝不去拿另一个"碰巧很远"的地名凑数（真机教训：那会为了"家"提醒，而计划说的是要塞）。
  const mentioned = all.filter((c) => c.name !== '' && input.planText.includes(c.name));
  if (mentioned.length > 0) {
    const farMentioned = mentioned.filter((c) => c.distance >= minDistance);
    if (farMentioned.length === 0) return null;
    return farMentioned.sort((a, b) => b.distance - a.distance)[0] ?? null;
  }
  // 一个都没点名：只有**唯一**一个够远的候选才用（有歧义不猜）。
  const far = all.filter((c) => c.distance >= minDistance);
  if (far.length !== 1) return null;
  return far[0] ?? null;
}

/** 要顶上去的那条调用（要能照抄：坐标是量出来的整数）。 */
export function longRangeNextCall(target: LongRangeTarget): string {
  return `travelTo(x=${Math.round(target.x)}, z=${Math.round(target.z)})`;
}

/**
 * 提醒内容（纯函数）：`note` 是说明行，`nextCall` 是要顶掉最后一行的调用。
 * 不该提醒时返回 null（用 travelTo、目标不够远、位置读不到、有歧义）。
 */
export function longRangeNudge(input: LongRangeNudgeInput): ReceiptHint | null {
  if (input.toolName !== 'mineTunnel') return null; // travelTo 本来就是干这个的
  const target = pickLongRangeTarget(input);
  if (target == null) return null;
  return {
    // **点名被顶掉的是哪一条**（"上面 mineTunnel 那条不要照做"）——悄悄换掉会留下两条
    // 互相矛盾的"照抄即可"，那正是我们整晚在删的"回执与世界不一致"。
    note:
      `⚠️ 上面 mineTunnel 那条**不要照做**：目标是 ${Math.round(target.distance)} 格外的 ${target.name}` +
      `（(x=${Math.round(target.x)}, z=${Math.round(target.z)})），mineTunnel 需要你自己保证方向对` +
      '（不给 direction 就按朝向猜，朝向常常是反的）。',
    nextCall: longRangeNextCall(target),
  };
}

/**
 * 把提醒应用到回执上（纯函数）。
 *
 * - 没有提醒 ⇒ **原样返回**（一个字节都不动）。
 * - 只有说明、没有 nextCall ⇒ 说明插在最后的「下一步」**之前**（最后一行不动）。
 * - 有 nextCall ⇒ 工具自己那条「下一步」**降级**成可见的"不要照做"，说明接在它后面，
 *   最后一行换成 `下一步（照做即可）：<nextCall>`；**全文只剩一条**「照做即可」。
 */
export function applyReceiptHint(text: string, hint: ReceiptHint | null): string {
  if (hint == null || (hint.note === '' && hint.nextCall == null)) return text;
  const lines = text.split('\n');
  const lastIndex = lines.length - 1;
  const last = lastIndex >= 0 ? (lines[lastIndex] ?? '') : '';
  const hasNextCallLine = last.startsWith(NEXT_CALL_PREFIX);
  // **幂等**：已经应用过同一条（说明在、最后一行也是它）就一个字节都不动。
  if (hint.nextCall != null && text.includes(hint.note) && last === `${NEXT_CALL_PREFIX}${hint.nextCall}`) return text;
  if (hint.nextCall == null && text.includes(hint.note)) return text;

  if (hint.nextCall == null) {
    // 不覆盖最后一行：说明插在它前面（保持"最后一行 = 能照抄的调用"）。
    if (hasNextCallLine) {
      lines.splice(lastIndex, 0, hint.note);
      return lines.join('\n');
    }
    return `${text}\n${hint.note}`;
  }

  if (!hasNextCallLine) {
    // 工具没给"下一步"行：说明 + 我们这条调用直接接在末尾。
    return `${text}\n${hint.note}\n${NEXT_CALL_PREFIX}${hint.nextCall}`;
  }

  const demoted = last.slice(NEXT_CALL_PREFIX.length);
  const replacement = [
    `- 工具自己的建议（**不要照做**）：${demoted}`,
    hint.note,
    `${NEXT_CALL_PREFIX}${hint.nextCall}`,
  ];
  lines.splice(lastIndex, 1, ...replacement);
  return lines.join('\n');
}
