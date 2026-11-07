/*
 * 工具调用的**校验**：未知工具、未知参数、缺必填、类型不对、越界，
 * 都变成带路径的 verdict，而不是抛错。
 *
 * 校验依据是身体握手报上来的声明（`ToolCatalog`）——大脑不 import 身体的
 * 命令实现，所以这里必须由调用方把目录传进来。
 *
 * 注意：pi-durable 自己也会按工具 schema 校验一次（`tool_schema.ts` 生成的
 * TypeBox schema）。这里是第二道，住在身体通道的入口（`ActionRunner`）上：
 * 它保证"被拒"这件事以**模型看得懂的回执**回到上下文里，而不是一个异常。
 */

import { SAY_LINE_LIMIT } from '../../shared/prompts.js';
import { domainBounds, stripBang, type ToolParamDef } from '../../shared/tools.js';
import { validateFeedback as validateFeedbackShape } from '../feedback.js';
import type { ToolCatalog } from './catalog.js';

/**
 * 控制类工具（循环/说话/计划/反馈 + 进程/安全护栏开关），走 handler，
 * **不占也不受**身体通道约束。
 *
 * ⚠️ `restart` / `disableSafeguards` / `restoreAllSafety` 必须在这里：
 * 真机 2026-10-18 17:15（overnight_b）保命反射卡住通道时，连
 * `restart` 和 `disableSafeguards` 都被
 * `An action is already running. Stop() first, then retry.` 拒掉——
 * 而这两个正是**因为通道卡住才会去用**的工具（它最后只能靠关掉自己的
 * 安全护栏来自救）。一个把"自救开关"也锁在故障通道后面的仲裁，
 * 本身就是危险。
 */
export const CONTROL_TOOLS = new Set([
  'Finish',
  'Stop',
  'Say',
  'UpdateGoal',
  'Feedback',
  // 进程控制：重启是"通道卡死"的最后手段，绝不能被通道挡住。
  'restart',
  // 安全护栏开关：必须在任何状态下可达（包括保命反射占着身体时）。
  'disableSafeguards',
  'restoreAllSafety',
  'allowDangerousOps',
]);

export interface ToolValidation {
  ok: boolean;
  code?: 'UNKNOWN_TOOL' | 'BAD_ARGS';
  errors?: string[];
}

/**
 * 数值参数的范围校验。domain 以前只写在命令定义里、既不进 schema
 * 也不校验，模型给个 -64 之外的 y 也照跑。这里按区间括号语义检查。
 */
export function checkDomain(param: ToolParamDef, value: number, path: string): string | null {
  const b = domainBounds(param);
  if (b == null) return null;
  if (b.min != null && (b.minExclusive ? value <= b.min : value < b.min)) {
    return `${path}: expected ${b.minExclusive ? '>' : '>='} ${b.min}, got ${value}`;
  }
  if (b.max != null && (b.maxExclusive ? value >= b.max : value > b.max)) {
    return `${path}: expected ${b.maxExclusive ? '<' : '<='} ${b.max}, got ${value}`;
  }
  return null;
}

function checkParamType(type: string, value: unknown, path: string): string | null {
  switch (type) {
    case 'int':
      return Number.isInteger(value) ? null : `${path}: expected integer, got ${JSON.stringify(value)}`;
    case 'float':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${path}: expected number, got ${JSON.stringify(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path}: expected boolean, got ${JSON.stringify(value)}`;
    default:
      // string / BlockName / ItemName / BlockOrItemName 都是字符串
      return typeof value === 'string' ? null : `${path}: expected string, got ${JSON.stringify(value)}`;
  }
}

/** 兼容检查：tool 名是否存在（不带 ! 也行）。 */
export function toolExists(catalog: ToolCatalog, toolName: string): boolean {
  if (CONTROL_TOOLS.has(toolName)) return true;
  return catalog.has(toolName);
}

/**
 * 该工具是否占用身体动作通道。动作类工具一次只能跑一个
 * （忙时拒绝，不排队）；查询类只读不占；控制类走 handler。
 */
export function isActionTool(catalog: ToolCatalog, toolName: string): boolean {
  const base = stripBang(toolName);
  if (CONTROL_TOOLS.has(base)) return false;
  return catalog.isAction(base);
}

/** Feedback 形状校验：title/body 必填非空字符串（错误带路径）。 */
export function validateFeedback(args: unknown): ToolValidation {
  const checked = validateFeedbackShape(args);
  if (checked.ok) return { ok: true };
  return { ok: false, code: 'BAD_ARGS', errors: checked.errors };
}

/** UpdateGoal 形状校验：goal 可选字符串，其它键一律拒绝。 */
export function validateUpdateGoal(args: unknown): ToolValidation {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'BAD_ARGS', errors: ['$: expected object'] };
  }
  const given = args as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(given)) {
    if (key !== 'goal') errors.push(`$: unknown property '${key}'`);
  }
  if (given['goal'] !== undefined && given['goal'] !== null && typeof given['goal'] !== 'string') {
    errors.push('$.goal: expected string');
  }
  if (errors.length > 0) return { ok: false, code: 'BAD_ARGS', errors };
  return { ok: true };
}

/**
 * 严格校验一次工具调用：未知工具、未知参数、缺必填、类型不对
 * 都变成带路径的 verdict，而不是抛错。null 视为"没给"：
 * 有 optional/default 的可缺，否则按缺失算。
 */
export function validateToolCall(catalog: ToolCatalog, toolName: string, args: unknown): ToolValidation {
  if (toolName === 'Finish' || toolName === 'Stop' || toolName === 'Say') return { ok: true };
  if (toolName === 'UpdateGoal') return validateUpdateGoal(args);
  if (toolName === 'Feedback') return validateFeedback(args);
  const command = catalog.get(toolName);
  if (command === undefined) return { ok: false, code: 'UNKNOWN_TOOL', errors: [`No such tool: ${toolName}.`] };
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'BAD_ARGS', errors: [`$: expected object, got ${Array.isArray(args) ? 'array' : typeof args}`] };
  }
  const params = command.params ?? {};
  const given = args as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(given)) {
    if (!(key in params)) errors.push(`$: unknown property '${key}'`);
  }
  for (const [name, def] of Object.entries(params)) {
    const value = given[name];
    const canOmit = def.optional === true || def.default !== undefined;
    if (value === undefined || value === null) {
      if (!canOmit) errors.push(`$: missing required property '${name}'`);
      continue;
    }
    const bad = checkParamType(def.type, value, `$.${name}`);
    if (bad) errors.push(bad);
    else if (typeof value === 'number') {
      // 类型对了还要在 domain 范围内：[-64,320] 这类约束以前形同虚设。
      const outOfRange = checkDomain(def, value, `$.${name}`);
      if (outOfRange) errors.push(outOfRange);
    }
  }
  if (errors.length > 0) return { ok: false, code: 'BAD_ARGS', errors };
  return { ok: true };
}

/**
 * Say 文案整形（纯函数）：空话拒绝，**超长也拒绝**。
 *
 * ⚠️ **超长不能再悄悄截断。** 以前这里是 `slice(0, 240) + '…'`，模型以为自己
 * 说完了那句话，实际上后半截根本没发出去——它没法发现自己被截了，因为回执
 * 里给的就是截断后的文本。用户的要求很直接：超了就报错，让它自己缩短，
 * 别替它决定丢掉哪半句。
 */
export function formatSay(text: unknown): { ok: boolean; line?: string; full?: string; reason?: string } {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: '没有给出要说的内容，所以什么也没有发出去。' };
  }
  const chars = Array.from(text.trim());
  if (chars.length > SAY_LINE_LIMIT) {
    return {
      ok: false,
      reason: `这段话说得太长了，一共 ${chars.length} 个字，上限是 ${SAY_LINE_LIMIT} 个字，所以没有发出去。`,
    };
  }
  return { ok: true, line: chars.join(''), full: text };
}
