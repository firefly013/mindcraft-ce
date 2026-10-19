/*
 * 「这个工具不是干这件事的」——**写在回执里**，而不是指望模型记得读工具说明。
 *
 * 真机（2026-10-19）：overnight_b 要去 380 格外的下界要塞拿烈焰棒，却一遍遍用
 * `mineTunnel`。那个工具**要求调用方自己保证方向**（模型常常没给 direction ⇒ 按朝向猜 ⇒ 挖反），
 * 而 `travelTo` 是按坐标算方向、自己规划腿、续跑也带坐标的。工具说明里已经写了，
 * 但**今晚量出来的事实是：模型跟回执比跟散文说明可靠得多**。
 *
 * 所以：只要它用 `mineTunnel` 去一个很远的目标，回执里就点名那个目标 + 给出 travelTo 的坐标。
 *
 * **目标从哪来**：身体**不知道 goal**（`edges.ts`：目标是大知识，身体不知道也不该知道），
 * 所以这件事只能在大脑侧做——它同时知道 plan（goal/todos）和 places（地名→坐标）。
 * 优先取"计划里提到的地名"；只有一个候选时用它；有歧义就**不猜**（宁可不提醒，也不指错地方）。
 */

/** 少于这么多格就不算"长途"（近处用 mineTunnel 完全合理）。 */
export const LONG_RANGE_MIN_BLOCKS = 96;

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

/**
 * 挑出"计划里那个很远的目标"（纯函数，可单测）。
 *
 * 规则：只在计划文本里**点名**的地名里挑；一个都没点名时，只有**唯一**一个够远的候选才用；
 * 其余情况返回 null（歧义不猜）。
 */
export function pickLongRangeTarget(input: LongRangeNudgeInput): LongRangeTarget | null {
  const minDistance = input.minDistance ?? LONG_RANGE_MIN_BLOCKS;
  if (input.here == null) return null;
  const candidates: LongRangeTarget[] = [];
  for (const [name, coords] of Object.entries(input.places ?? {})) {
    if (!Array.isArray(coords) || coords.length < 3) continue;
    const x = Number(coords[0]);
    const z = Number(coords[2]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const distance = Math.hypot(x - input.here.x, z - input.here.z);
    if (distance < minDistance) continue;
    candidates.push({ name, x, z, distance });
  }
  if (candidates.length === 0) return null;
  const mentioned = candidates.filter((c) => c.name !== '' && input.planText.includes(c.name));
  if (mentioned.length > 0) {
    return mentioned.sort((a, b) => b.distance - a.distance)[0] ?? null;
  }
  if (candidates.length === 1) return candidates[0] ?? null;
  return null;
}

/** 那句提醒本身（要能照抄：里面必须有一个**具体**的 travelTo 调用）。 */
export function longRangeNudge(input: LongRangeNudgeInput): string | null {
  if (input.toolName !== 'mineTunnel') return null; // travelTo 本来就是干这个的
  const target = pickLongRangeTarget(input);
  if (target == null) return null;
  const x = Math.round(target.x);
  const z = Math.round(target.z);
  return (
    `⚠️ **去 ${target.name}（${Math.round(target.distance)} 格外，(x=${x}, z=${z})）请用 ` +
    `travelTo(x=${x}, z=${z})**：它按坐标算方向、自己规划腿、续跑也带坐标；` +
    'mineTunnel 需要你自己保证方向对（不给 direction 就按朝向猜，朝向常常是反的）。'
  );
}

/**
 * 把提醒插进回执：**插在最后一行「下一步」之前**。
 *
 * 回执的"最后一行是能照抄的下一步"是条硬规矩（模型靠它行动），提醒不能把它顶掉。
 * 没有「下一步」行时就直接接在末尾。
 */
export function withLongRangeNudge(text: string, nudge: string | null): string {
  if (nudge == null || nudge === '') return text;
  if (text.includes(nudge)) return text; // 幂等：同一条提醒不重复堆
  const lines = text.split('\n');
  const lastIndex = lines.length - 1;
  if (lastIndex >= 0 && lines[lastIndex]?.startsWith('下一步（照做即可）：')) {
    lines.splice(lastIndex, 0, nudge);
    return lines.join('\n');
  }
  return `${text}\n${nudge}`;
}
