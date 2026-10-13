/*
 * 工具目录：把**身体握手里报上来的声明**变成大脑可查的表。
 *
 * 为什么要有这一层：大脑不能用身体的代码，它只能在握手时拿到一份纯数据的
 * `ToolDeclaration[]`（`BodyCapabilities.tools`）。装配工具 schema、校验参数、
 * 判断"这个工具占不占身体通道"全都要查这份目录——查的是同一份，
 * 不会出现"schema 里有、校验器里没有"的漂移。
 */

import { stripBang, type ToolDeclaration } from '../../shared/tools.js';

/** 只读的工具目录（名字不带 `!`，与协议一致）。 */
export interface ToolCatalog {
  all(): readonly ToolDeclaration[];
  get(name: string): ToolDeclaration | undefined;
  has(name: string): boolean;
  /** 动作类：要认领身体通道，一次只能跑一个。 */
  isAction(name: string): boolean;
  /** 查询类：只读、瞬间返回，不占身体通道。 */
  isReadOnly(name: string): boolean;
}

export function createToolCatalog(declarations: readonly ToolDeclaration[]): ToolCatalog {
  const byName = new Map<string, ToolDeclaration>();
  for (const declaration of declarations) byName.set(stripBang(declaration.name), declaration);
  return {
    all: () => declarations,
    get: (name: string) => byName.get(stripBang(name)),
    has: (name: string) => byName.has(stripBang(name)),
    isAction: (name: string) => byName.get(stripBang(name))?.kind === 'action',
    isReadOnly: (name: string) => byName.get(stripBang(name))?.kind === 'query',
  };
}

/** 握手之前 / 没有身体时用的空目录：一个工具都没有，这是事实，不是占位。 */
export const EMPTY_TOOL_CATALOG: ToolCatalog = createToolCatalog([]);
