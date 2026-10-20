/**
 * 渲染重映射：**表是数据，逻辑是纯函数**。
 *
 * 背景：世界 1.21.11、`prismarine-viewer` 只认到 1.21.4 ⇒ 它拿错版本的状态表解区块
 * （全表只有 9.6% 对、84.3% 被画成别的方块、6.1% 画「?」）。这里钉住翻译器的行为：
 *   - exact  ⇒ 换成渲染器同名方块的 state id；
 *   - approx ⇒ 换成视觉近邻（并说明是近似，不是"画对"）；
 *   - none    ⇒ 返回 null（**保持原值**，渲染器画「?」，回执会如实计入），**绝不换成 0**。
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
    mappingForBlockName,
    mappingForStateId,
    remapCoverage,
    remapStateId,
    RENDERER_VERSION,
    WORLD_VERSION,
} from '../src/body/vision/state_remap.js';
import { RENDER_REMAP } from '../src/body/vision/generated/render_remap.js';

const require = createRequire(import.meta.url);
const mcdata = require('minecraft-data') as (v: string) => any;

function stateIdOf(version: string, name: string): number | null {
    const info = mcdata(version)?.blocksByName?.[name];
    const id = Number(info?.defaultState ?? info?.minStateId);
    return Number.isFinite(id) ? id : null;
}

describe('重映射表：world → renderer 的逐方块映射', () => {
    it('版本常量与生成时一致（表不是给别的版本用的）', () => {
        expect(WORLD_VERSION).toBe('1.21.11');
        expect(RENDERER_VERSION).toBe('1.21.4');
    });

    it('同名方块 ⇒ exact，且换成渲染器的 state id（不是原 id）', () => {
        const mapping = mappingForBlockName('deepslate');
        expect(mapping?.kind).toBe('exact');
        const rendererId = stateIdOf(RENDERER_VERSION, 'deepslate');
        expect(mapping?.stateId).toBe(rendererId);
        // 世界里的那个 id 和渲染器的 id 本来就不同 —— 这正是"画错"的根源
        expect(stateIdOf(WORLD_VERSION, 'deepslate')).not.toBe(rendererId);
    });

    it('同族折叠 ⇒ approx（渲染器没有这一变体），并写明折到哪个名字、为什么', () => {
        const mapping = mappingForBlockName('exposed_copper_bars');
        expect(mapping?.kind).toBe('approx');
        expect(mapping?.via).toBe('exposed_copper');
        expect(mapping?.why).toContain('同族折叠');
    });

    it('人工近邻在**表**里且有理由（不是逻辑里藏特例）', () => {
        const mapping = mappingForBlockName('bush');
        expect(mapping?.kind).toBe('approx');
        expect(mapping?.via).toBe('short_grass');
        expect(mapping?.why).toContain('1.21.4 没有');
    });

    it('无法映射 ⇒ none / stateId null（渲染器会画「?」，不许假装成空气）', () => {
        const mapping = mappingForBlockName('test_block');
        expect(mapping?.kind).toBe('none');
        expect(mapping?.stateId).toBeNull();
        expect(remapStateId(stateIdOf(WORLD_VERSION, 'test_block'))).toBeNull();
    });

    it('按 state id 也能查到（走 1.21.11 的方块名）', () => {
        const id = stateIdOf(WORLD_VERSION, 'deepslate_iron_ore');
        expect(id).not.toBeNull();
        const mapping = mappingForStateId(id);
        expect(mapping?.name).toBe('deepslate_iron_ore');
        expect(mapping?.kind).toBe('exact');
        expect(remapStateId(id)).toBe(stateIdOf(RENDERER_VERSION, 'deepslate_iron_ore'));
    });

    it('乱输入 ⇒ null（不猜、不崩）', () => {
        for (const junk of [null, undefined, '', 'no_such_block_xyz', -1, 1e9, Number.NaN]) {
            expect(mappingForBlockName(junk)).toBeNull();
            expect(mappingForStateId(junk)).toBeNull();
        }
    });

    it('覆盖率是 registry 级的下界（数字来自生成物）', () => {
        const coverage = remapCoverage();
        expect(coverage.total).toBeGreaterThan(1000);
        expect(coverage.exact + coverage.approx + coverage.none).toBe(coverage.total);
        // 大多数方块同名 ⇒ exact 应该占绝对多数
        expect(coverage.exact / coverage.total).toBeGreaterThan(0.9);
        // 表里条数和 summary 对得上
        expect(Object.keys(RENDER_REMAP).length).toBe(coverage.total);
    });
});
