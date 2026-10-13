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

/** 控制类工具（循环/说话/计划/反馈），走 handler，不占身体通道。 */
export const CONTROL_TOOLS = new Set(['Finish', 'Stop', 'Say', 'UpdatePlan', 'Feedback']);

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

/** UpdatePlan 形状校验：goal 可选字符串，todos 可选 {text,done}[]（整单替换）。
 *  注意这里比 JSON Schema **更宽松**（收纯字符串、done 可省，按未完成折算）：
 *  schema 是给模型看的严格形式，校验器负责兼容旧格式，二者故意不一致。 */
export function validateUpdatePlan(args: unknown): ToolValidation {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, code: 'BAD_ARGS', errors: ['$: expected object'] };
  }
  const given = args as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(given)) {
    if (key !== 'goal' && key !== 'todos') errors.push(`$: unknown property '${key}'`);
  }
  if (given['goal'] !== undefined && given['goal'] !== null && typeof given['goal'] !== 'string') {
    errors.push('$.goal: expected string');
  }
  if (given['todos'] !== undefined && given['todos'] !== null) {
    const todos = given['todos'];
    if (!Array.isArray(todos)) {
      errors.push('$.todos: expected array');
    } else {
      todos.forEach((todo, i) => {
        const path = `$.todos[${i}]`;
        // 旧格式（纯字符串）仍然收，按未完成折算。
        if (typeof todo === 'string') return;
        if (todo == null || typeof todo !== 'object' || Array.isArray(todo)) {
          errors.push(`${path}: expected object {text,done}`);
          return;
        }
        const entry = todo as Record<string, unknown>;
        for (const key of Object.keys(entry)) {
          if (key !== 'text' && key !== 'done') errors.push(`${path}: unknown property '${key}'`);
        }
        if (typeof entry['text'] !== 'string' || entry['text'].trim() === '') {
          errors.push(`${path}.text: expected non-empty string`);
        }
        if (entry['done'] !== undefined && typeof entry['done'] !== 'boolean') {
          errors.push(`${path}.done: expected boolean`);
        }
      });
    }
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
  if (toolName === 'UpdatePlan') return validateUpdatePlan(args);
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
    return { ok: false, reason: 'Say text must be non-empty.' };
  }
  const chars = Array.from(text.trim());
  if (chars.length > SAY_LINE_LIMIT) {
    return {
      ok: false,
      reason:
        `Say 太长：${chars.length} 字，上限 ${SAY_LINE_LIMIT} 字（游戏内聊天发不出去）。` +
        `请自己缩短到 ${SAY_LINE_LIMIT} 字以内再说一次——我不会替你截断，那样你不知道哪半句被丢了。`,
    };
  }
  return { ok: true, line: chars.join(''), full: text };
}
