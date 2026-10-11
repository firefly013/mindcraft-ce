/**
 * token 粗估（预算 guard，不是计费表）。
 *
 * CJK 一个字 ≈ 1 token，ASCII ≈ 1/4。**故意往大了估**——早压比晚压安全。
 *
 * 注意：真正的 token 数只信 provider 报的 `usage`；这个估算只在没有 usage
 * 锚点时用来兜底（以及感知层给"这块内容值多少预算"定级）。
 *
 * 与 Pi 的一处有意偏差：Pi 用 `chars/4` 估算，中文会被严重低估
 * （一个汉字 ≈1 token，不是 0.25）。这里沿用本项目的 CJK 感知估算。
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of String(text)) {
    // 用 charCodeAt 而不是 codePointAt：后者在类型上可能返回 undefined，
    // 而 for...of 迭代出的每一段都非空——那个 `?? 0` 是够不到的分支。
    // 代价是星平面字符按高代理位算（> 阈值 → 记 1 token），仍是往大估。
    tokens += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}
