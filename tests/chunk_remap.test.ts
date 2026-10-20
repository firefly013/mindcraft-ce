/**
 * 区块 JSON 的 state 翻译器：**只翻 id，不动结构**，永不抛。
 *
 * 拦截点在 `WorldView.loadChunk`（整列）与 `blockUpdate`（增量）。这里用合成结构钉住
 * 它能认识的三种形状（`{i: id}` / `id[]` / `{palette: id[]}`），以及三条纪律：
 *   ① 不能映射的 id **保持原值**（不换 0 —— 换 0 会被画成空气，静默撒谎）；
 *   ② 没变化就返回**原对象**（不制造无谓拷贝）；
 *   ③ 翻译器抛错 ⇒ 原样返回（画面更破，但绝不中断截图链）。
 */
import { describe, expect, it } from 'vitest';
import { remapBlockUpdateStateId, remapChunkJson } from '../src/body/vision/chunk_remap.js';

const double = (id: number): number | null => (id === 5 || id === 7 ? id * 2 : null);

describe('remapChunkJson', () => {
    it('`{ index: stateId }` 形状（toJson 的常见形态）：逐项翻译', () => {
        const json = { 0: 5, 1: 7, 2: 9 };
        expect(remapChunkJson(json, double)).toEqual({ 0: 10, 1: 14, 2: 9 }); // 9 不能映射 ⇒ 保持
    });

    it('id 数组形状：逐项翻译', () => {
        expect(remapChunkJson([5, 7, 9], double)).toEqual([10, 14, 9]);
    });

    it('`{ palette: [...] }` 形状：**只翻 palette**，其它字段一字不动', () => {
        const json = { type: 'palette', palette: [5, 7], data: [0, 1, 1, 0], y: 3 };
        expect(remapChunkJson(json, double)).toEqual({ type: 'palette', palette: [10, 14], data: [0, 1, 1, 0], y: 3 });
    });

    it('嵌套结构（sections）也认', () => {
        const json = { sections: [{ palette: [5] }, { palette: [7] }] };
        expect(remapChunkJson(json, double)).toEqual({ sections: [{ palette: [10] }, { palette: [14] }] });
    });

    it('没有可翻的东西 ⇒ 返回**原对象**（不制造拷贝）', () => {
        const json = { a: 1, b: 'x', c: { d: true } };
        expect(remapChunkJson(json, double)).toBe(json);
    });

    it('翻译器抛错 ⇒ 原样返回，绝不抛出去（截图链不能断）', () => {
        const boom = (): number | null => {
            throw new Error('boom');
        };
        const json = { 0: 5 };
        expect(remapChunkJson(json, boom)).toBe(json);
    });

    it('定型数组也能翻（转普通数组）', () => {
        const arr = new Int32Array([5, 7, 9]);
        expect(remapChunkJson(arr, double)).toEqual([10, 14, 9]);
    });

    it('病态深度不炸（有深度上限）', () => {
        let deep: any = 5;
        for (let i = 0; i < 20; i += 1) deep = { nested: deep };
        expect(() => remapChunkJson(deep, double)).not.toThrow();
    });
});

describe('remapBlockUpdateStateId', () => {
    it('能映射 ⇒ 换成渲染器 id；不能映射 ⇒ **保持原值**', () => {
        expect(remapBlockUpdateStateId(5, double)).toBe(10);
        expect(remapBlockUpdateStateId(9, double)).toBe(9);
    });

    it('乱输入 ⇒ 原样返回', () => {
        for (const junk of [null, undefined, 'x', Number.NaN]) {
            expect(remapBlockUpdateStateId(junk, double)).toBe(junk);
        }
    });

    it('翻译器抛错 ⇒ 原样返回', () => {
        const boom = (): number | null => {
            throw new Error('boom');
        };
        expect(remapBlockUpdateStateId(5, boom)).toBe(5);
    });
});
