/**
 * **渲染重映射的解析器**（表是生成的，逻辑在这里，两者分开）。
 *
 * 世界版本（`WORLD_VERSION`）→ 渲染器版本（`RENDERER_VERSION`）：
 * `prismarine-viewer` 的 `supportedVersions` 硬编码到 1.21.4 为止，而世界是 1.21.11
 * ⇒ 它拿错版本的方块状态表解区块（全表只有 9.6% 画对、84.3% 画成别的方块、6.1% 画「?」）。
 *
 * 这里把"世界里的方块"翻译成"渲染器认识的 state id"：
 *   - `exact`  ⇒ 同名同视觉，直接换 id；
 *   - `approx` ⇒ 渲染器没有这一变体，按**人工/同族规则**折到视觉近邻（表里写了 why）；
 *   - `none`   ⇒ 无法映射 ⇒ 返回 null，**保持原样**（渲染器画「?」，且回执会如实计入）。
 *
 * 纪律：这张表是**数据**（`generated/render_remap.ts`，由脚本生成、checked in），
 * 世界升级时重新生成，不改这里的代码。
 */
import { createRequire } from 'node:module';
import {
    RENDER_REMAP,
    RENDER_REMAP_SUMMARY,
    RENDERER_VERSION,
    WORLD_VERSION,
} from './generated/render_remap.js';

/**
 * ## 验证状态（**只写验过的**）
 *
 * - **地表剖面：已真机验证**（2026-10-20，`6e623bc` 重启后一帧 800×512）：
 *   画面是连贯的 1.21.11 地形 —— 草地/梯田状崖壁（草皮压边）、短草与高草**分辨正确**、
 *   树、石质崖面上的矿石斑点；**零「?」贴图、零错贴图、零悬浮几何**。
 *   对照重映射前的签名（9.6% 对 / 84.3% 静默画错 / 6.1% 「?」），地表这条频率剖面**修好了**。
 * - **地下剖面（y≈-10，最初报的那处）：尚未验证** —— 拿到那一帧之前，
 *   不许收紧回执里的残余数字，也不许声称地下也修好了。
 */

export { RENDER_REMAP, RENDER_REMAP_SUMMARY, RENDERER_VERSION, WORLD_VERSION };

export type RemapKind = 'exact' | 'approx' | 'none';

export interface RemapEntry {
    /** 渲染器里要用的 state id；`none` 时为 null。 */
    stateId: number | null;
    kind: RemapKind;
    /** approx 时折叠到的渲染器方块名。 */
    via?: string;
    /** 人话理由。 */
    why?: string;
}

export interface BlockMapping extends RemapEntry {
    /** 世界里的方块名。 */
    name: string;
}

let stateIdToNameCache: Map<number, string> | null = null;

function stateIdToName(): Map<number, string> | null {
    if (stateIdToNameCache != null) return stateIdToNameCache;
    try {
        const require = createRequire(import.meta.url);
        const mcdata = require('minecraft-data') as (v: string) => any;
        const table = mcdata(WORLD_VERSION)?.blocksByStateId;
        if (table == null || typeof table !== 'object') return null;
        const map = new Map<number, string>();
        for (const key of Object.keys(table)) {
            const name = table[key]?.name;
            const id = Number(key);
            if (typeof name === 'string' && Number.isFinite(id)) map.set(id, name);
        }
        stateIdToNameCache = map;
        return map;
    } catch {
        return null;
    }
}

/** 按**世界**的方块名查映射。表里没有 ⇒ null（不猜）。 */
export function mappingForBlockName(name: unknown): BlockMapping | null {
    if (typeof name !== 'string' || name === '') return null;
    const entry = RENDER_REMAP[name];
    if (entry == null) return null;
    return { name, ...entry };
}

/** 按**世界**的 state id 查映射（先查名字，再查表）。读不到 ⇒ null。 */
export function mappingForStateId(stateId: unknown): BlockMapping | null {
    // **`null` / `''` 都不是 0**：`Number(null) === 0`、`Number('') === 0` ⇒ 直转会把
    // "没给值"读成"空气"（静默撒谎）。这正是 Lead 那条 fail-open/closed 教训的同款坑：
    // 拿可能缺失的值直接转数字之前，先判类型。
    if (stateId == null) return null;
    if (typeof stateId === 'string' && stateId.trim() === '') return null;
    const id = Number(stateId);
    if (!Number.isFinite(id)) return null;
    const names = stateIdToName();
    if (names == null) return null;
    const name = names.get(id);
    if (name == null) return null;
    return mappingForBlockName(name);
}

/**
 * state id → 渲染器要用的 state id。
 *
 * 返回 null = **不能映射**（`none`，渲染器会画「?」）。调用方必须**保持原值**而不是
 * 换成 0（换成 0 = 静默画成空气，那比「?」更骗人）。
 */
export function remapStateId(stateId: unknown): number | null {
    const mapping = mappingForStateId(stateId);
    if (mapping == null) return null;
    return mapping.stateId ?? null;
}

/** registry 级覆盖率（给日志/回执用；频率加权的数字在生成器输出里）。 */
export function remapCoverage(): { exact: number; approx: number; none: number; total: number } {
    return { ...RENDER_REMAP_SUMMARY };
}
