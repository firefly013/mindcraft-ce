/**
 * **这张截图能不能当"世界的样子"用？**
 *
 * 真机（overnight_a，1.21.11 新世界）：在 y=-10 的深板岩矿道里截图，整片是
 * 「?」图标平铺的方块 + 一大片淡蓝空白，模型据此判断"掉进虚空/贴图全丢"；
 * 而同一份快照的方块数据（deepslate_iron_ore、y=-10、light 0）说明世界完全正常。
 *
 * 这是今晚第四次同一个形状：**没有数据被画成了数据**
 * （复活窗口、容器槽位、开着的背包读数、现在是渲染器）。
 *
 * 定量结论（实测，不是猜 —— 见 tests/frame_trust.test.ts 与交付说明）：
 *   - 世界版本 1.21.11；`prismarine-viewer` 的 `supportedVersions` 最高只到 **1.21.4**，
 *     `getVersion('1.21.11')` 返回 **'1.21.4'**（同一 major 的最后一版）。
 *   - 于是它用 **1.21.4 的状态表**去解 **1.21.11 的区块数据**。全表对照（29671 个状态）：
 *       · 只有 **9.6%** 能一比一画对
 *       · **84.3%** 会被画成**另一个方块**（静默错误，比「?」更能骗人；例：`bush`→`seagrass`）
 *       · **6.1%** 渲染器表里没有 ⇒ 画 `missing_texture`（那个「?」格子）
 *   - 没有几何的地方露出天空色（蓝）⇒ 模型读成"虚空"。
 *   - 所以「?」和蓝色空白**不是**"没有方块"、也不是"太黑看不见"，是**渲染器版本落后于世界**。
 *
 * 纪律：
 *   ① **不许把坏帧当可信视图**：只要判定不可信，转述给模型的那一行必须明说；
 *   ② **不删图**（用户的开发原则是"视觉是前提"，退化成纯文本是反向退化）；
 *   ③ **数值只报能测到的**：比例是"**至少**这么多"，读不到就说读数不可用。
 */

import { createRequire } from 'node:module';

export interface FrameTrustInput {
    /** 世界版本（`bot.version`）。 */
    worldVersion: string;
    /** 渲染器实际会用的版本（`prismarine-viewer` 的 `getVersion` 结果）；null = 它不认这个版本。 */
    rendererVersion: string | null;
    /** 渲染器那份状态表的最大 state id；null = 读不到。 */
    rendererMaxState: number | null;
    /** 世界那份状态表的最大 state id；null = 读不到。 */
    worldMaxState: number | null;
    /** 视口内实际采到的方块（**带真实名字**才能分辨"画错"而不只是"画不出"）。 */
    sampledBlocks: ReadonlyArray<{ stateId: number; name?: string | null }>;
    /**
     * 渲染器会把某个 state id 当成哪个方块。返回 null = 它的表里没有这个 id
     * （会画 `missing_texture`，即「?」）。
     */
    rendererNameOf?: ((stateId: number) => string | null) | null;
}

export interface FrameTrust {
    /** 画面能不能当"世界的样子"用。 */
    trusted: boolean;
    /** 视口内**至少**有多大比例的方块渲染器认不出（会画成「?」）。null = 测不出来。 */
    unknownRatio: number | null;
    /** 有多大比例的方块**会被画成另一个方块**（静默错，比「?」更危险）。null = 没名字可比。 */
    wrongRatio: number | null;
    /** 一比一画对的比例。null = 测不出来。 */
    correctRatio: number | null;
    /** 一句话结论（可信时为空串，零噪音）。 */
    line: string;
    /** 给日志用的原因标签：`version_skew` / `renderer_unsupported` / `ok`。 */
    reason: 'ok' | 'version_skew' | 'renderer_unsupported';
}

/** 越界（> 渲染器最大 state id）的比例；只数"能判定越界"的样本。 */
function outOfRangeRatio(
    sampled: ReadonlyArray<{ stateId: number }> | undefined,
    rendererMaxState: number | null,
): number | null {
    if (sampled == null || sampled.length === 0) return null;
    if (rendererMaxState == null || !Number.isFinite(rendererMaxState)) return null;
    let over = 0;
    for (const block of sampled) {
        const id = Number(block?.stateId);
        if (!Number.isFinite(id) || id < 0) continue;
        if (id > rendererMaxState) over += 1;
    }
    return over / sampled.length;
}

/**
 * 一比一地核每个方块：**认不出**（渲染器表里没这个 id ⇒「?」）/ **画错**（表里有但名字不同 ⇒
 * 静默画成别的方块）/ **对**。名字缺失的样本不计入任何一类（不猜）。
 */
export function compareSampledBlocks(
    sampled: ReadonlyArray<{ stateId: number; name?: string | null }> | undefined,
    rendererNameOf: ((stateId: number) => string | null) | null | undefined,
): { unknownRatio: number | null; wrongRatio: number | null; correctRatio: number | null; counted: number } {
    const none = { unknownRatio: null, wrongRatio: null, correctRatio: null, counted: 0 } as const;
    if (sampled == null || sampled.length === 0 || rendererNameOf == null) return none;
    let unknown = 0;
    let wrong = 0;
    let correct = 0;
    let counted = 0;
    for (const block of sampled) {
        const id = Number(block?.stateId);
        const truth = typeof block?.name === 'string' && block.name !== '' ? block.name : null;
        if (!Number.isFinite(id) || truth == null) continue;
        let rendered: string | null = null;
        try {
            rendered = rendererNameOf(id);
        } catch {
            rendered = null;
        }
        counted += 1;
        if (rendered == null || rendered === '') unknown += 1;
        else if (rendered !== truth) wrong += 1;
        else correct += 1;
    }
    if (counted === 0) return none;
    return {
        unknownRatio: unknown / counted,
        wrongRatio: wrong / counted,
        correctRatio: correct / counted,
        counted,
    };
}

const CLOSE =
    '画面里的「?」贴图和蓝色空白是**渲染失败**，**不是虚空、也不代表那里没有方块**；' +
    '以方块数据为准（near key blocks 是真实读数）。';

const pct = (ratio: number | null): string | null => (ratio == null ? null : `${Math.round(ratio * 100)}%`);

/**
 * 纯函数：根据"世界版本 / 渲染器版本 / 状态表 / 采样"判断这张图可不可信。
 */
export function assessFrameTrust(input: FrameTrustInput): FrameTrust {
    const world = String(input.worldVersion ?? '');
    const renderer = input.rendererVersion == null ? null : String(input.rendererVersion);
    const none = { unknownRatio: null, wrongRatio: null, correctRatio: null } as const;
    if (world === '') {
        return {
            trusted: false,
            ...none,
            reason: 'renderer_unsupported',
            line: `⚠️ **这张图不可信**：读不到世界版本。${CLOSE}`,
        };
    }
    if (renderer == null || renderer === '') {
        return {
            trusted: false,
            ...none,
            reason: 'renderer_unsupported',
            line: `⚠️ **这张图不可信**：渲染器**不支持**世界版本 ${world}（它没有这个版本的方块数据）。${CLOSE}`,
        };
    }
    if (renderer !== world) {
        const compared = compareSampledBlocks(input.sampledBlocks, input.rendererNameOf);
        const unknownRatio = compared.unknownRatio ?? outOfRangeRatio(input.sampledBlocks, input.rendererMaxState);
        const parts: string[] = [];
        const unknownPct = pct(unknownRatio);
        const wrongPct = pct(compared.wrongRatio);
        const correctPct = pct(compared.correctRatio);
        if (unknownPct != null) parts.push(`**至少 ${unknownPct}** 的方块它认不出（画成「?」）`);
        if (wrongPct != null) parts.push(`另有 **${wrongPct}** 会被画成**别的方块**（静默画错，比「?」更能骗人）`);
        if (correctPct != null) parts.push(`只有 ${correctPct} 是对的`);
        const numbers = parts.length > 0 ? parts.join('，') : '比例测不出来（这次没采到能核对的方块）';
        const caveat =
            compared.counted > 0
                ? '（比例是**按两版方块状态表对照估算**的；两版解包格式若不同，实际只会更糟）'
                : '';
        return {
            trusted: false,
            unknownRatio,
            wrongRatio: compared.wrongRatio,
            correctRatio: compared.correctRatio,
            reason: 'version_skew',
            line:
                `⚠️ **这张图不可信（不能当现场照）**：世界是 ${world}，渲染器只到 ${renderer}` +
                '（`prismarine-viewer` 只认到那个版本）⇒ 附近方块里 ' +
                numbers +
                '。' +
                caveat +
                CLOSE +
                '（这只是渲染问题，**你并没有掉进虚空**；看画面之前先看这条。）',
        };
    }
    // 版本一致 ⇒ 渲染数据是同一份；采样越界只可能是脏数据，不当成"不可信"的理由。
    return { trusted: true, ...none, reason: 'ok', line: '' };
}

// ───────────────────────── 量测（会读 bot / 依赖包，永不抛） ─────────────────────────

export interface FrameTrustDeps {
    /** 世界版本 → 渲染器会用的版本（默认 `prismarine-viewer` 的 `getVersion`）。 */
    viewerVersionOf?: (worldVersion: string) => string | null;
    /** 版本 → 那份方块状态表的最大 state id（默认 `minecraft-data`）。 */
    maxStateOf?: (version: string) => number | null;
    /** 渲染器版本 → 该版本里某个 state id 对应的方块名（默认 `minecraft-data`）。 */
    rendererNameOf?: (version: string) => ((stateId: number) => string | null) | null;
    /** 采样视口内的方块（默认读 `bot.blockAt`）。 */
    sampleBlocks?: (count: number) => Array<{ stateId?: unknown; name?: unknown }>;
    /** 采样多少个点（默认 24）。 */
    sampleCount?: number;
}

function defaultViewerVersionOf(worldVersion: string): string | null {
    try {
        // prismarine-viewer 是 CJS，而且这里只要一个纯函数：不值得为它改 import 形态。
        const require = createRequire(import.meta.url);
        const mod = require('prismarine-viewer/viewer/lib/version.js') as { getVersion?: (v: string) => string | null };
        const got = mod?.getVersion?.(worldVersion);
        return typeof got === 'string' && got !== '' ? got : null;
    } catch {
        return null;
    }
}

function mcdataOf(version: string): any {
    const require = createRequire(import.meta.url);
    const mcdata = require('minecraft-data') as (v: string) => any;
    return mcdata(version);
}

function defaultMaxStateOf(version: string): number | null {
    try {
        const table = mcdataOf(version)?.blocksByStateId;
        if (table == null || typeof table !== 'object') return null;
        let max = -1;
        for (const key of Object.keys(table)) {
            const id = Number(key);
            if (Number.isFinite(id) && id > max) max = id;
        }
        return max >= 0 ? max : null;
    } catch {
        return null;
    }
}

function defaultRendererNameOf(version: string): ((stateId: number) => string | null) | null {
    try {
        const table = mcdataOf(version)?.blocksByStateId;
        if (table == null || typeof table !== 'object') return null;
        return (stateId: number): string | null => {
            const entry = table[stateId];
            const name = entry?.name;
            return typeof name === 'string' && name !== '' ? name : null;
        };
    } catch {
        return null;
    }
}

/** mineflayer 的 `blockAt` 要 Vec3；给普通对象时新版本会自己 floored。 */
function vec3At(x: number, y: number, z: number): { x: number; y: number; z: number } {
    return { x, y, z };
}

function defaultSampleBlocks(bot: any, count: number): Array<{ stateId?: unknown; name?: unknown }> {
    const out: Array<{ stateId?: unknown; name?: unknown }> = [];
    try {
        const pos = bot?.entity?.position;
        if (pos == null) return out;
        const cx = Math.round(Number(pos.x));
        const cy = Math.round(Number(pos.y));
        const cz = Math.round(Number(pos.z));
        // 一个 5×5×5 的网格（跳过空气；找不到方块不算错，样本少了就少报）。
        for (let dx = -2; dx <= 2 && out.length < count; dx += 1) {
            for (let dy = -2; dy <= 2 && out.length < count; dy += 1) {
                for (let dz = -2; dz <= 2 && out.length < count; dz += 1) {
                    let block: any = null;
                    try {
                        block = bot?.blockAt?.(vec3At(cx + dx, cy + dy, cz + dz));
                    } catch {
                        block = null;
                    }
                    if (block == null) continue;
                    const name = String((block as { name?: unknown }).name ?? '');
                    if (name === '' || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
                    out.push(block as { stateId?: unknown; name?: unknown });
                }
            }
        }
    } catch {
        return out;
    }
    return out;
}

/**
 * 读当前 bot 的实际情况，给出这张截图的信任判定。**任何一步读不到都不抛**：
 * 读不到就按"不可信 + 读数不可用"处理（宁可让模型知道图不可信，也不给它一个假视图）。
 */
export function measureFrameTrust(bot: any, deps: FrameTrustDeps = {}): FrameTrust {
    const worldVersion = (() => {
        try {
            return typeof bot?.version === 'string' ? bot.version : '';
        } catch {
            return '';
        }
    })();
    const viewerVersionOf = deps.viewerVersionOf ?? defaultViewerVersionOf;
    const maxStateOf = deps.maxStateOf ?? defaultMaxStateOf;
    const rendererNameFactory = deps.rendererNameOf ?? defaultRendererNameOf;
    const sampleCount = deps.sampleCount ?? 24;
    const sample = deps.sampleBlocks ?? ((count: number) => defaultSampleBlocks(bot, count));

    const safe = <T>(fn: () => T, fallback: T): T => {
        try {
            return fn();
        } catch {
            return fallback;
        }
    };

    const rendererVersion = worldVersion === '' ? null : safe(() => viewerVersionOf(worldVersion), null);
    const rendererMaxState = rendererVersion == null ? null : safe(() => maxStateOf(rendererVersion), null);
    const worldMaxState = worldVersion === '' ? null : safe(() => maxStateOf(worldVersion), null);
    const rendererNameOf = rendererVersion == null ? null : safe(() => rendererNameFactory(rendererVersion), null);

    const sampledBlocks: Array<{ stateId: number; name?: string | null }> = [];
    safe(() => {
        for (const block of sample(sampleCount)) {
            const id = Number((block as { stateId?: unknown })?.stateId);
            if (!Number.isFinite(id)) continue;
            const name = (block as { name?: unknown })?.name;
            sampledBlocks.push({ stateId: id, name: typeof name === 'string' ? name : null });
        }
        return null;
    }, null);

    return assessFrameTrust({
        worldVersion,
        rendererVersion,
        rendererMaxState,
        worldMaxState,
        sampledBlocks,
        rendererNameOf,
    });
}
