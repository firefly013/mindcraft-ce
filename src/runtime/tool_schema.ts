/**
 * P4：把现有的命令参数 DSL 转成 TypeBox schema。
 *
 * 目标不是"重新设计工具"，而是**逐关键字等价**地把 `to_openai_tools.ts` 里
 * `paramToSchema` 的输出换成 TypeBox 表达——同一个 JSON Schema，只是现在由
 * TypeBox 生成，因而能被 pi-durable 的 `validateToolArguments()` 真正校验。
 *
 * 等价的证据在 `tests/runtime_tools.test.ts`：对全部 47 个命令工具逐个比对
 * 新旧 schema 的 JSON 形态。
 */
import { Type, type TSchema } from '@earendil-works/pi-ai';
import type { AgentCommand, CommandParamDef } from '../agent/commands/actions.js';

/** 与 `to_openai_tools.ts` 的 `domainBounds` 逐字一致。 */
function domainBounds(param: CommandParamDef): {
  min: number | null;
  max: number | null;
  minExclusive: boolean;
  maxExclusive: boolean;
} | null {
  const domain = param.domain;
  if (!Array.isArray(domain) || domain.length < 2) return null;
  const min = typeof domain[0] === 'number' ? domain[0] : null;
  const max = typeof domain[1] === 'number' ? domain[1] : null;
  if (min == null && max == null) return null;
  const brackets = typeof domain[2] === 'string' ? domain[2] : '[]';
  return { min, max, minExclusive: brackets.startsWith('('), maxExclusive: brackets.endsWith(')') };
}

/**
 * 数值参数的 TypeBox 选项：把 domain 的**有限**上下界带出去。
 *
 * 开区间必须用 `exclusiveMinimum/Maximum` 表达——JSON Schema 的
 * `minimum/maximum` 是闭语义，用错会让广告给模型的区间比 `checkDomain`
 * 实际放行的更宽（模型给 0 是"合法"，到校验器却被拒）。
 * `±Infinity` 直接丢弃，与旧实现一致。
 */
function numericOptions(param: CommandParamDef, description: string): Record<string, unknown> {
  const options: Record<string, unknown> = { description };
  const b = domainBounds(param);
  if (b?.min != null && Number.isFinite(b.min)) {
    options[b.minExclusive ? 'exclusiveMinimum' : 'minimum'] = b.min;
  }
  if (b?.max != null && Number.isFinite(b.max)) {
    options[b.maxExclusive ? 'exclusiveMaximum' : 'maximum'] = b.max;
  }
  return options;
}

/** 单个 DSL 参数 → TypeBox schema。 */
export function paramSchema(param: CommandParamDef): TSchema {
  const description = typeof param.description === 'string' ? param.description : '';
  switch (param.type) {
    case 'int':
      return Type.Integer(numericOptions(param, description));
    case 'float':
      return Type.Number(numericOptions(param, description));
    case 'boolean':
      return Type.Boolean({ description });
    // BlockName / ItemName / BlockOrItemName 与 string 一样：DSL 里没有
    // 枚举信息，只能表达为无约束字符串（与旧实现一致）。
    default:
      return Type.String({ description });
  }
}

/**
 * 命令参数名，顺序即 `Object.keys(command.params)`——`perform` 收的是
 * **位置参数**，顺序错了整个工具就错位。
 */
export function paramNames(command: AgentCommand): string[] {
  return command.params ? Object.keys(command.params) : [];
}

/**
 * 命令 → TypeBox 对象 schema。
 *
 * `required` 判定与 `commandToTool` 一致：声明了 `optional` 或 `default` 的
 * 参数不能进 required，否则 schema 比校验器更严（校验器的 canOmit 会放行）。
 */
export function commandParameters(command: AgentCommand): TSchema {
  const properties: Record<string, TSchema> = {};
  if (command.params) {
    for (const [name, param] of Object.entries(command.params)) {
      const schema = paramSchema(param);
      properties[name] =
        param.optional === true || param.default !== undefined ? Type.Optional(schema) : schema;
    }
  }
  return Type.Object(properties, { additionalProperties: false });
}
