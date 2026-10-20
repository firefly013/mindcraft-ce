/**
 * 生成 **渲染重映射表**：`1.21.11 世界 → 1.21.4 渲染器`。
 *
 * 背景（真机 overnight_a）：世界是 1.21.11，而 `prismarine-viewer@1.33.0` 的
 * `supportedVersions` 硬编码到 1.21.4 为止 ⇒ 它用 **1.21.4 的方块状态表**去解
 * 1.21.11 的区块 ⇒ 全表对照只有 9.6% 画对、84.3% 画成别的方块、6.1% 画成「?」。
 *
 * 修法是**数据**不是逻辑（Lead 2026-10-20 裁定）：本脚本按**文档化的规则**生成一张表，
 * 表里逐方块写清 `exact`（同名同视觉）/ `approx`（折叠到视觉近邻，附原因）/ `none`（无法映射，
 * 只能保持「?」），生成物 **checked in**。世界升级到 1.21.12 时重新生成即可，不改代码。
 *
 * 用法：`npx tsx scripts/vision/generate_render_remap.ts [--write]`
 *   - 不带 `--write` 只打印覆盖率与按频率加权的"重灾区"，不落盘（便于先看数）。
 *   - 带 `--write` 写 `src/body/vision/generated/render_remap.ts`。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const mcdata = require('minecraft-data') as (v: string) => any;

export const WORLD_VERSION = '1.21.11';
export const RENDERER_VERSION = '1.21.4';

/** 一条映射。 */
export interface RemapEntry {
    /** 渲染器（1.21.4）里要用的 state id；`none` 时为 null（保持「?」）。 */
    stateId: number | null;
    kind: 'exact' | 'approx' | 'none';
    /** approx 时是折叠到的 1.21.4 方块名。 */
    via?: string;
    /** 人话理由（approx / none 必填，便于以后复核）。 */
    why?: string;
}

/**
 * **近似映射的人工清单**：只在"改名/新方块 → 最近视觉近邻"时用，必须写理由。
 *
 * 纪律：能同名就同名（`exact`）；折叠是**故意**的近似，宁可承认"看起来差不多"，
 * 也不能让模型看到一片「?」。**绝不**把结构方块（门/床/箱子）折成实心方块。
 */
const APPROX_OVERRIDES: Record<string, [string, string]> = {
    // 1.21.5+ 的植物/装饰：折到同色系的草/花，视觉上"那里有东西"即可
    bush: ['short_grass', '细小灌木，1.21.4 没有；折到短草（同为绿色低矮植被）'],
    short_dry_grass: ['short_grass', '干草，1.21.4 没有；折到短草（同为低矮植被）'],
    tall_dry_grass: ['tall_grass', '高干草，1.21.4 没有；折到高草'],
    firefly_bush: ['short_grass', '萤火虫灌木，1.21.4 没有；折到短草'],
    leaf_litter: ['short_grass', '落叶层，1.21.4 没有；折到短草'],
    wildflowers: ['dandelion', '野花丛，1.21.4 没有；折到蒲公英'],
    cactus_flower: ['dandelion', '仙人掌花，1.21.4 没有；折到蒲公英'],
    // 1.21.9+ 的 pale garden 系列：折到同形状的橡木/桦木族
    pale_oak_log: ['oak_log', '苍白橡木，1.21.4 没有；折到橡木（同形状、同用途）'],
    pale_oak_wood: ['oak_wood', '同上'],
    pale_oak_planks: ['oak_planks', '同上'],
    pale_oak_leaves: ['oak_leaves', '同上'],
    pale_oak_sapling: ['oak_sapling', '同上'],
    creaking_heart: ['oak_log', '1.21.9 方块，1.21.4 没有；折到橡木原木（同尺寸）'],
    // 铜的新变体：同形状的氧化铜块在 1.21.4 里没有"未氧化/打蜡"区分时折到最近的一档
    copper_lantern: ['lantern', '铜灯笼，1.21.11 没有对应；折到灯笼'],
};

/** 折叠规则：把"同族的变体"折回基础方块（顺序敏感：先剥后缀，再剥前缀）。 */
const FAMILY_SUFFIXES = [
    '_wall',
    '_fence_gate',
    '_fence',
    '_slab',
    '_stairs',
    '_trapdoor',
    '_door',
    '_button',
    '_pressure_plate',
    '_hanging_sign',
    '_sign',
    '_banner',
    '_carpet',
    '_pane',
    '_bars',
    '_candle_cake',
    '_candle',
    '_chain',
];

function foldToFamily(name: string): string[] {
    const candidates: string[] = [];
    let base = name;
    for (const suffix of FAMILY_SUFFIXES) {
        if (base.endsWith(suffix) && base.length > suffix.length) {
            base = base.slice(0, -suffix.length);
            candidates.push(base);
        }
    }
    if (name.startsWith('potted_')) candidates.push(name.slice('potted_'.length));
    if (name.startsWith('waxed_')) candidates.push(name.slice('waxed_'.length));
    if (name.startsWith('infested_')) candidates.push(name.slice('infested_'.length));
    return candidates.filter((c) => c !== name && c !== '');
}

/** 一个方块在渲染器里要用的 state id（默认状态）。 */
function defaultStateOf(version: string, name: string): number | null {
    const info = mcdata(version)?.blocksByName?.[name];
    if (info == null) return null;
    if (Number.isFinite(info.defaultState)) return Number(info.defaultState);
    if (Number.isFinite(info.minStateId)) return Number(info.minStateId);
    return null;
}

/** 构造整张表（纯函数，便于测试与复用）。 */
export function buildRemapTable(): {
    blocks: Record<string, RemapEntry>;
    summary: { exact: number; approx: number; none: number; total: number };
    approxReasons: Record<string, string>;
    unmappable: string[];
} {
    const world = mcdata(WORLD_VERSION) as any;
    const renderer = mcdata(RENDERER_VERSION) as any;
    const names: string[] = (world.blocksArray as Array<{ name: string }>).map((b) => b.name).sort();
    const blocks: Record<string, RemapEntry> = {};
    const approxReasons: Record<string, string> = {};
    const unmappable: string[] = [];
    let exact = 0;
    let approx = 0;

    for (const name of names) {
        // 空气类：渲染器里有同名 air ✓（exact 处理）
        const rendererInfo = renderer.blocksByName[name];
        if (rendererInfo != null) {
            const stateId = defaultStateOf(RENDERER_VERSION, name);
            if (stateId != null) {
                blocks[name] = { stateId, kind: 'exact' };
                exact += 1;
                continue;
            }
        }
        // 人工清单优先（理由写清）
        const override = APPROX_OVERRIDES[name];
        if (override != null) {
            const [via, why] = override;
            const stateId = defaultStateOf(RENDERER_VERSION, via);
            if (stateId != null) {
                blocks[name] = { stateId, kind: 'approx', via, why };
                approxReasons[name] = why;
                approx += 1;
                continue;
            }
        }
        // 同族折叠（门/台阶/墙/蜡铜/盆栽…）
        let folded = false;
        for (const base of foldToFamily(name)) {
            const stateId = defaultStateOf(RENDERER_VERSION, base);
            if (stateId != null) {
                const why = `同族折叠：${name} → ${base}（同形状/同材质，渲染器没有这一变体）`;
                blocks[name] = { stateId, kind: 'approx', via: base, why };
                approxReasons[name] = why;
                approx += 1;
                folded = true;
                break;
            }
        }
        if (folded) continue;
        blocks[name] = { stateId: null, kind: 'none', why: '渲染器 1.21.4 里没有同名方块，也没有可折叠的同族基础方块' };
        unmappable.push(name);
    }

    return { blocks, summary: { exact, approx, none: unmappable.length, total: names.length }, approxReasons, unmappable };
}

/**
 * **频率剖面**（文档化的采样模型，不是真机统计）：用来判断"哪些错得最要命"，
 * 因为按注册表数量排序会把一辈子见不到一次的方块排到前面。
 *
 * 权重是同一剖面内的相对比例；真机跑一轮后可以换成真实方块直方图。
 */
const PROFILES: Array<{ name: string; weights: Record<string, number> }> = [
    {
        name: 'underground(y≈-10，真机那次的位置)',
        weights: {
            deepslate: 55,
            tuff: 6,
            cave_air: 8,
            air: 8,
            stone: 3,
            cobbled_deepslate: 2,
            gravel: 1.2,
            deepslate_coal_ore: 0.8,
            deepslate_iron_ore: 1.2,
            deepslate_copper_ore: 1.0,
            deepslate_redstone_ore: 0.5,
            deepslate_gold_ore: 0.35,
            deepslate_lapis_ore: 0.2,
            deepslate_diamond_ore: 0.15,
            lava: 0.6,
            water: 0.4,
            dirt: 0.5,
            magma_block: 0.2,
        },
    },
    {
        name: 'surface(y≈64，草地上)',
        weights: {
            air: 45,
            grass_block: 15,
            dirt: 9,
            stone: 7,
            water: 5,
            short_grass: 4,
            oak_leaves: 4,
            sand: 3,
            oak_log: 2,
            gravel: 2,
            coal_ore: 1,
            iron_ore: 0.8,
            poppy: 0.5,
            dandelion: 0.5,
            tall_grass: 0.8,
        },
    },
];

export interface Offender {
    name: string;
    kind: 'approx' | 'none';
    sharePct: number;
    via?: string;
    why?: string;
}

/** 按频率加权的"重灾区"（两种剖面分别算）。 */
export function rankOffenders(table: ReturnType<typeof buildRemapTable>): Array<{ profile: string; offenders: Offender[] }> {
    return PROFILES.map((profile) => {
        const total = Object.values(profile.weights).reduce((a, b) => a + b, 0);
        const offenders: Offender[] = [];
        for (const [name, weight] of Object.entries(profile.weights)) {
            const entry = table.blocks[name];
            if (entry == null) continue;
            if (entry.kind === 'exact') continue;
            offenders.push({
                name,
                kind: entry.kind === 'none' ? 'none' : 'approx',
                sharePct: (weight / total) * 100,
                ...(entry.via != null ? { via: entry.via } : {}),
                ...(entry.why != null ? { why: entry.why } : {}),
            });
        }
        offenders.sort((a, b) => b.sharePct - a.sharePct);
        return { profile: profile.name, offenders };
    });
}

function renderGeneratedFile(table: ReturnType<typeof buildRemapTable>): string {
    const entries = Object.entries(table.blocks)
        .map(([name, entry]) => {
            const fields = [`    stateId: ${entry.stateId == null ? 'null' : entry.stateId}`, `kind: '${entry.kind}'`];
            if (entry.via != null) fields.push(`via: ${JSON.stringify(entry.via)}`);
            if (entry.why != null) fields.push(`why: ${JSON.stringify(entry.why)}`);
            return `  ${JSON.stringify(name)}: { ${fields.join(', ')} },`;
        })
        .join('\n');
    const header = [
        '/**',
        ' * **自动生成，请勿手改。**',
        ' *',
        ' * 生成器：`scripts/vision/generate_render_remap.ts`',
        ` * 世界 ${WORLD_VERSION} → 渲染器 ${RENDERER_VERSION}（prismarine-viewer 的版本上限）`,
        ' *',
        ` * 覆盖率：exact ${table.summary.exact} / approx ${table.summary.approx} / none ${table.summary.none}（共 ${table.summary.total}）`,
        ' *',
        ' * 重新生成：`npx tsx scripts/vision/generate_render_remap.ts --write`',
        ' */',
    ].join('\n');
    return `${header}
import type { RemapEntry } from '../state_remap.js';

export const WORLD_VERSION = ${JSON.stringify(WORLD_VERSION)};
export const RENDERER_VERSION = ${JSON.stringify(RENDERER_VERSION)};
export const RENDER_REMAP_SUMMARY = ${JSON.stringify(table.summary)};

export const RENDER_REMAP: Readonly<Record<string, RemapEntry>> = {
${entries}
};
`;
}

// ───────────────────────── CLI ─────────────────────────
function main(): void {
    const table = buildRemapTable();
    const pct = (n: number): string => `${((n / table.summary.total) * 100).toFixed(1)}%`;
    console.log(`世界 ${WORLD_VERSION} → 渲染器 ${RENDERER_VERSION}`);
    console.log(
        `覆盖率：exact ${table.summary.exact} (${pct(table.summary.exact)})  ` +
            `approx ${table.summary.approx} (${pct(table.summary.approx)})  ` +
            `none ${table.summary.none} (${pct(table.summary.none)})  共 ${table.summary.total}`,
    );
    console.log('');
    for (const { profile, offenders } of rankOffenders(table)) {
        console.log(`【${profile}】按出现频率加权的重灾区（前 10）：`);
        if (offenders.length === 0) console.log('  （无）');
        for (const o of offenders.slice(0, 10)) {
            const share = o.sharePct.toFixed(1);
            console.log(
                `  ${share.padStart(5)}%  ${o.name.padEnd(28)} ${o.kind}` +
                    (o.via != null ? ` → ${o.via}` : '') +
                    (o.why != null ? `  // ${o.why}` : ''),
            );
        }
        console.log('');
    }
    if (table.unmappable.length > 0) {
        console.log(`无法映射（保持「?」）共 ${table.unmappable.length} 个：`);
        console.log('  ' + table.unmappable.slice(0, 40).join(', ') + (table.unmappable.length > 40 ? ' …' : ''));
    }

    if (process.argv.includes('--write')) {
        const outDir = path.join(process.cwd(), 'src', 'body', 'vision', 'generated');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, 'render_remap.ts');
        fs.writeFileSync(outFile, renderGeneratedFile(table));
        console.log(`\n已写入 ${path.relative(process.cwd(), outFile)}`);
    } else {
        console.log('\n（未写入；加 --write 才落盘）');
    }
}

if (process.argv[1] != null && /generate_render_remap/.test(process.argv[1])) main();
