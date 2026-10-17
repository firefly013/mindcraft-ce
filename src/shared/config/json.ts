/**
 * 配置文件读取的小工具：BOM 与 JSONC 注释。
 *
 * 照搬 Pi 的两条规矩：`settings.json` / profile 走严格 JSON；
 * `providers.json` 允许注释（`stripJsonComments`）。
 */

/** 去掉文件开头的 BOM（Windows 上编辑器很爱加）。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 去掉 JSON 里的行注释与块注释（字符串里的不算）。
 *
 * 与 Pi 的 `utils/json.ts` 同一件事：只删注释，不碰其它字符——删注释会让
 * 位置信息偏移，但报错用的是解析器给出的行列，不受影响。
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  return out;
}
