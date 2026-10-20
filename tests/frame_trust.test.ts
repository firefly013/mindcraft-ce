/**
 * **坏帧不许冒充世界**（真机 overnight_a，1.21.11 新世界，y=-10 的深板岩矿道）。
 *
 * 那张图整片是「?」图标平铺 + 一大片淡蓝空白，模型读成"掉进虚空/贴图全丢"；
 * 同一份快照的方块数据（deepslate_iron_ore、y=-10、light 0）说明世界是好的。
 *
 * 根因（实测，见 frame_trust.ts 顶部注释）：世界 1.21.11，`prismarine-viewer` 的
 * `supportedVersions` 最高 1.21.4，`getVersion('1.21.11')` = **'1.21.4'** ⇒ 它拿
 * 1.21.4 的方块状态表去解 1.21.11 的区块 ⇒ 大量状态越界 ⇒ `missing_texture`（「?」）。
 *
 * 这里钉三件事：
 *   ① 版本不一致 ⇒ **必须**判不可信，并且说清"N% 是渲染失败，不是虚空"；
 *   ② 版本一致 ⇒ **零噪音**（不留一句废话）；
 *   ③ 图照发（这条在 vision_interpreter 的接线里，不删图）。
 */
import { describe, expect, it } from 'vitest';
import { assessFrameTrust, measureFrameTrust } from '../src/body/vision/frame_trust.js';

/** 1.21.4 与 1.21.11 的真实规模（实测：1.21.11 有 29671 个状态 id，1.21.4 上限 27865）。 */
const RENDERER_MAX_1214 = 27865;
const WORLD_MAX_1211 = 29670;

/** 用一张"名字表"模拟渲染器的解析结果（测试里不加载真数据，保持确定）。 */
const rendererNames = (table: Record<number, string | undefined>) => (stateId: number) => table[stateId] ?? null;

describe('assessFrameTrust：坏帧 = 版本对不上，不是虚空', () => {
    it('世界 1.21.11 / 渲染器 1.21.4 ⇒ 不可信，且三类比例分开说（认不出 / 画错 / 对）', () => {
        const trust = assessFrameTrust({
            worldVersion: '1.21.11',
            rendererVersion: '1.21.4',
            rendererMaxState: RENDERER_MAX_1214,
            worldMaxState: WORLD_MAX_1211,
            // 4 个方块：1 个渲染器认不出（越界 ⇒ 「?」）、2 个被画成别的方块、1 个对
            sampledBlocks: [
                { stateId: 29500, name: 'deepslate_iron_ore' }, // 越界
                { stateId: 2051, name: 'bush' }, // 1.21.4 会画成 seagrass
                { stateId: 2052, name: 'short_dry_grass' }, // 1.21.4 会画成 tall_seagrass
                { stateId: 100, name: 'stone' }, // 一致
            ],
            rendererNameOf: rendererNames({ 2051: 'seagrass', 2052: 'tall_seagrass', 100: 'stone' }),
        });
        expect(trust.trusted).toBe(false);
        expect(trust.reason).toBe('version_skew');
        expect(trust.unknownRatio).toBeCloseTo(1 / 4, 5);
        expect(trust.wrongRatio).toBeCloseTo(2 / 4, 5);
        expect(trust.correctRatio).toBeCloseTo(1 / 4, 5);
        expect(trust.line).toContain('这张图的渲染不可全信');
        expect(trust.line).toContain('世界是 1.21.11');
        expect(trust.line).toContain('渲染器只到 1.21.4');
        expect(trust.line).toContain('至少 25%');
        expect(trust.line).toContain('另有');
        expect(trust.line).toContain('被画成**别的方块**');
        expect(trust.line).toContain('只有 25% 是对的');
        // 关键三句：不许把坏帧读成虚空/没有方块
        expect(trust.line).toContain('地形判断以 near key blocks 的方块数据为准');
        expect(trust.line).toContain('整片天空/空白也可能只是这一侧确实没有方块');
        expect(trust.line).toContain('以 near key blocks 的方块数据为准');
        expect(trust.line).not.toContain('掉进虚空');
    });

    it('**静默画错**是最危险的那类：表里有 id 但名字不同 ⇒ 单独计数，不能混进"没坏"', () => {
        const trust = assessFrameTrust({
            worldVersion: '1.21.11',
            rendererVersion: '1.21.4',
            rendererMaxState: RENDERER_MAX_1214,
            worldMaxState: WORLD_MAX_1211,
            sampledBlocks: [
                { stateId: 2051, name: 'bush' },
                { stateId: 2054, name: 'seagrass' },
            ],
            rendererNameOf: rendererNames({ 2051: 'seagrass', 2054: 'piston' }),
        });
        expect(trust.unknownRatio).toBe(0); // 一个都不越界……
        expect(trust.wrongRatio).toBe(1); // ……但两个都被画成了别的方块
        expect(trust.trusted).toBe(false);
        expect(trust.line).toContain('被画成**别的方块**');
        expect(trust.line).toContain('至少 0%'); // 认不出的比例确实是 0（不夸张）
    });

    it('没采到能核对的方块 ⇒ 不编比例，写"测不出来"，但仍然不可信', () => {
        const trust = assessFrameTrust({
            worldVersion: '1.21.11',
            rendererVersion: '1.21.4',
            rendererMaxState: RENDERER_MAX_1214,
            worldMaxState: WORLD_MAX_1211,
            sampledBlocks: [],
        });
        expect(trust.trusted).toBe(false);
        expect(trust.unknownRatio).toBeNull();
        expect(trust.line).toContain('比例测不出来');
        expect(trust.line).toContain('这张图的渲染不可全信');
    });

    it('没有名字表时退化成"越界比例"（只报能测到的）', () => {
        const trust = assessFrameTrust({
            worldVersion: '1.21.11',
            rendererVersion: '1.21.4',
            rendererMaxState: RENDERER_MAX_1214,
            worldMaxState: WORLD_MAX_1211,
            sampledBlocks: [{ stateId: 29000 }, { stateId: 100 }],
        });
        expect(trust.unknownRatio).toBeCloseTo(1 / 2, 5);
        expect(trust.wrongRatio).toBeNull();
        expect(trust.line).toContain('至少 50%');
        expect(trust.line).not.toContain('被画成**别的方块**');
    });

    it('渲染器**根本不支持**这个版本 ⇒ 不可信 + 点名不支持（不是"图是空的"）', () => {
        const trust = assessFrameTrust({
            worldVersion: '1.22.0',
            rendererVersion: null,
            rendererMaxState: null,
            worldMaxState: null,
            sampledBlocks: [],
        });
        expect(trust.trusted).toBe(false);
        expect(trust.reason).toBe('renderer_unsupported');
        expect(trust.line).toContain('不支持');
        expect(trust.line).toContain('1.22.0');
        expect(trust.line).toContain('以 near key blocks 的方块数据为准');
    });

    it('版本一致 ⇒ **零噪音**（可信就是可信，不写一句废话）', () => {
        const trust = assessFrameTrust({
            worldVersion: '1.21.4',
            rendererVersion: '1.21.4',
            rendererMaxState: RENDERER_MAX_1214,
            worldMaxState: RENDERER_MAX_1214,
            sampledBlocks: [{ stateId: 100, name: 'stone' }],
            rendererNameOf: rendererNames({ 100: 'stone' }),
        });
        expect(trust.trusted).toBe(true);
        expect(trust.reason).toBe('ok');
        expect(trust.line).toBe('');
    });

    it('读不到世界版本 ⇒ 不可信 + 说清是哪一步读不到', () => {
        const trust = assessFrameTrust({
            worldVersion: '',
            rendererVersion: '1.21.4',
            rendererMaxState: RENDERER_MAX_1214,
            worldMaxState: null,
            sampledBlocks: [],
        });
        expect(trust.trusted).toBe(false);
        expect(trust.line).toContain('读不到世界版本');
    });
});

describe('measureFrameTrust：读 bot 实际情况，永不抛', () => {
    const bot = (version: string) => ({
        version,
        entity: { position: { x: 0, y: -10, z: 0 } },
        blockAt: () => ({ name: 'deepslate_iron_ore', stateId: 29500 }),
    });

    it('版本落后 ⇒ 三类比例都能量，回执里带"N%"', () => {
        const trust = measureFrameTrust(bot('1.21.11'), {
            viewerVersionOf: () => '1.21.4',
            maxStateOf: (v) => (v === '1.21.4' ? RENDERER_MAX_1214 : WORLD_MAX_1211),
            rendererNameOf: () => rendererNames({ 100: 'stone', 2051: 'seagrass' }),
            sampleBlocks: () => [
                { stateId: 29500, name: 'deepslate_iron_ore' },
                { stateId: 2051, name: 'bush' },
                { stateId: 100, name: 'stone' },
            ],
        });
        expect(trust.trusted).toBe(false);
        expect(trust.unknownRatio).toBeCloseTo(1 / 3, 5);
        expect(trust.wrongRatio).toBeCloseTo(1 / 3, 5);
        expect(trust.correctRatio).toBeCloseTo(1 / 3, 5);
        expect(trust.line).toContain('至少 33%');
    });

    it('依赖包读不到（抛错）⇒ 不炸，按"不可信"处理', () => {
        const trust = measureFrameTrust(bot('1.21.11'), {
            viewerVersionOf: () => {
                throw new Error('boom');
            },
            maxStateOf: () => {
                throw new Error('boom');
            },
            rendererNameOf: () => {
                throw new Error('boom');
            },
            sampleBlocks: () => {
                throw new Error('boom');
            },
        });
        expect(trust.trusted).toBe(false);
        expect(trust.unknownRatio).toBeNull();
        expect(trust.line).toContain('这张图的渲染不可全信');
    });

    it('真依赖链也能量（本仓 prismarine-viewer 只认到 1.21.4 ⇒ 1.21.11 必须判不可信）', () => {
        const trust = measureFrameTrust(bot('1.21.11'), {
            sampleBlocks: () => [{ stateId: 29500, name: 'deepslate_iron_ore' }],
        });
        if (trust.reason === 'ok') {
            // 将来 prismarine-viewer 支持 1.21.11 时这里自然会变可信 —— 那才是真的修好。
            expect(trust.line).toBe('');
        } else {
            expect(trust.trusted).toBe(false);
            expect(trust.line).toContain('1.21.11');
            expect(trust.line).toContain('不可全信');
        }
    });
});

describe('重映射生效后：报的是**残余误差**，不是旧数字', () => {
    const base = {
        worldVersion: '1.21.11',
        rendererVersion: '1.21.4',
        rendererMaxState: RENDERER_MAX_1214,
        worldMaxState: WORLD_MAX_1211,
        remapApplied: true,
    };

    it('全部一对一 ⇒ 画面可信、**零噪音**（不再拿旧数字吓模型）', () => {
        const trust = assessFrameTrust({
            ...base,
            sampledBlocks: [{ stateId: 1, name: 'stone' }],
            remapOf: () => ({ stateId: 5, kind: 'exact' }),
        });
        expect(trust.trusted).toBe(true);
        expect(trust.line).toBe('');
        expect(trust.unknownRatio).toBeNull(); // 旧数字不许漏出来
    });

    it('混合 ⇒ 三类残余都说清（一致 / 近似 / 仍无法渲染）', () => {
        const trust = assessFrameTrust({
            ...base,
            sampledBlocks: [
                { stateId: 1, name: 'stone' },
                { stateId: 2, name: 'bush' },
                { stateId: 3, name: 'test_block' },
            ],
            remapOf: (id) =>
                id === 1 ? { stateId: 5, kind: 'exact' } : id === 2 ? { stateId: 6, kind: 'approx' } : { stateId: null, kind: 'none' },
        });
        expect(trust.trusted).toBe(false);
        expect(trust.unknownRatio).toBeCloseTo(1 / 3, 5);
        expect(trust.wrongRatio).toBeCloseTo(1 / 3, 5);
        expect(trust.correctRatio).toBeCloseTo(1 / 3, 5);
        expect(trust.line).toContain('已启用 state 重映射');
        expect(trust.line).toContain('33% 一致');
        expect(trust.line).toContain('33% 是近似');
        expect(trust.line).toContain('33% 仍无法渲染');
        expect(trust.line).toContain('以 near key blocks 的方块数据为准');
    });
});
