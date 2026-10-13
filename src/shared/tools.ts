/*
 * 工具契约：**声明**的形状。
 *
 * 一个工具由两部分组成，这是它们的分界线：
 *   - **声明**（本文件）：名字、描述、参数表、要不要附图、是不是长动作。
 *     身体在握手里把它交给大脑；大脑据此装配 schema、做参数校验、
 *     决定哪些工具占身体通道。CLI 的 `help` 也读它。
 *   - **实现**（`perform`，只在身体侧）：真正调 mineflayer 的那段代码。
 *
 * 为什么必须分开：以前大脑直接 import 身体的命令表（连 `skills.ts` 一起
 * 加载进大脑进程），于是"身体和大脑是两个进程"只是拓扑上的说法——
 * 大脑里照样躺着整份 mineflayer 代码。拆开之后大脑只认这份声明，
 * 身体进程死不死、换不换成 Java 客户端，大脑都不用改。
 *
 * 本文件是纯数据/纯函数，不许 import 身体或大脑的实现。
 */

/** 工具种类：查询类只读不占身体通道，动作类要认领身体通道。 */
export type ToolKind = 'query' | 'action';

/** 一个工具参数的声明（原来的命令参数 DSL，逐字保留）。 */
export interface ToolParamDef {
    type: string;
    description?: string;
    domain?: unknown;
    optional?: boolean;
    default?: unknown;
    [key: string]: unknown;
}

/**
 * 一个工具的声明。
 *
 * `name` **不带前导 `!`**（OpenAI 的工具名不允许 `!`；协议里也一直是这个约定）。
 * `params` 的 key 顺序就是 `perform` 的位置参数顺序——顺序错了整个工具就错位，
 * 而 JSON 只保序不保名。
 */
export interface ToolDeclaration {
    name: string;
    description: string;
    params?: Record<string, ToolParamDef>;
    /** 这条命令的回执要附一张现拍的截图。默认不给。 */
    withScreenshot?: boolean;
    /**
     * 走身体通道（能跑几分钟）。由身体侧 `runAsAction` 打在实现上的标记决定，
     * **不写死清单**：清单会漏、会过期。CLI 据此强制异步。
     */
    longRunning?: boolean;
    kind: ToolKind;
}

/** '!goToPlayer' -> 'goToPlayer'（工具名不带 `!` 前缀）。 */
export function stripBang(name: string): string {
    return name.startsWith('!') ? name.slice(1) : name;
}

/** domain 形如 [min, max] 或 [min, max, '[)']；第三项是区间括号，缺省两端闭。 */
export function domainBounds(param: ToolParamDef): {
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
