/*
 * 「这个工具不是干这件事的」——**写在回执里**，而且必要时**顶掉最后一行**。
 *
 * 真机（2026-10-19）：overnight_b 要去 380 格外的下界要塞拿烈焰棒，却一遍遍用
 * `mineTunnel`。那个工具**要求调用方自己保证方向**（模型常常没给 direction ⇒ 按朝向猜 ⇒ 挖反），
 * 而 `travelTo` 是按坐标算方向、自己规划腿、续跑也带坐标的。工具说明里已经写了，
 * 但**今晚量出来的事实是：模型跟回执比跟散文说明可靠得多**。
 *
 * **2026-10-30 起只追加说明，不改回执**（用户裁定：大脑不许替模型写"下一步"）。
 * 它现在做的唯一一件事：当大脑知道目标在 343 格外、而 mineTunnel 需要调用方自己保证方向时，
 * 在回执末尾补一句**事实**（目标在哪、多远、这个工具的方向要你自己给）。
 * 不回执里塞调用、不把工具自己那行降级、不覆盖任何内容。
 * 不该提醒的时候（用 travelTo、目标很近、读不到位置、有歧义），**回执一个字节都不动**。
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
  /**
   * 这次调用带进来的 `handoff`（谁把它叫来的）。
   *
   * **循环闸门**：如果是 `travelTo` 把活儿交给 `mineTunnel`（`handoff="travelTo"`），
   * 那我们**不能再把它交回 travelTo** —— 那就是真机那个"两个工具互相踢皮球、同一位置都 0 位移"。
   * 这时只报循环 + 给一条**不是兄弟工具**的出路。
   */
  handoffFrom?: string | null;
}

/** `handoff` 参数可能是 `"travelTo"`/`"!travelTo"`/大小写混写 ⇒ 归一到工具名。 */
export function normalizeToolName(raw: unknown): 'travelTo' | 'mineTunnel' | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace(/^!/, '');
  if (value === 'travelto') return 'travelTo';
  if (value === 'minetunnel') return 'mineTunnel';
  return null;
}

export interface LongRangeTarget {
  name: string;
  x: number;
  z: number;
  distance: number;
}

/** 大脑侧要往回执里追加的东西：**只有一行说明**（不给调用）。 */
export interface ReceiptHint {
  note: string;
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

/**
 * 提醒内容（纯函数）。
 *
 * 2026-11-06：提醒本身就是"下一步该怎么走"的建议（"这个工具不合适/要你自己保证方向"），
 * 按用户要求删除——回执只报工具自己的结果，不再由大脑追加上下文。现在恒为 null，
 * 保留函数只为不打断调用方/测试的接口形状。
 */
export function longRangeNudge(input: LongRangeNudgeInput): ReceiptHint | null {
  void input;
  return null;
}

/**
 * 把提醒应用到回执上（纯函数）：**只在末尾追加一段说明**，不改、不顶掉任何已有内容。
 *
 * 以前这里会把工具自己那条「下一步」降级成"不要照做"，再顶上一句我们写的调用——
 * 等于大脑替模型改写了工具的证据。2026-10-30 起回执里不再有那种行，这里也就只剩追加。
 */
export function applyReceiptHint(text: string, hint: ReceiptHint | null): string {
  if (hint == null || hint.note === '') return text;
  if (text.includes(hint.note)) return text; // 幂等
  return `${text}
${hint.note}`;
}
