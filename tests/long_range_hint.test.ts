/**
 * 远目标提醒已删除（2026-11-06）：回执只报工具自己的结果，大脑不再追加
 * "这个工具不合适/目标在 X 格外的 Y"这类建议。这里锁两件事：
 *   1. `longRangeNudge` 恒为 null（提醒不再进回执）；
 *   2. `pickLongRangeTarget` / `normalizeToolName` 这两个纯函数仍可用于别处，
 *      行为不变（避免将来有人把它们一起删掉时没有回归线）。
 */
import { describe, expect, it } from 'vitest';
import { actionChannelInvoker } from '../src/brain/tools/game_tools.js';
import {
    LONG_RANGE_MIN_BLOCKS,
    applyReceiptHint,
    longRangeNudge,
    normalizeToolName,
    pickLongRangeTarget,
} from '../src/brain/tools/long_range_hint.js';

const fortress: [number, number, number] = [-332, 64, 88];

const bodyReceipt = [
    'mineTunnel：沿 -x 净前进 12/32 格（实测位移 12.0 格：(0, 64, 0) → 现在 (-12, 64, 0)）。',
    '停止原因：时间到（内部预算）主动收手。',
].join('\n');

const hintFor = (over: Partial<Parameters<typeof longRangeNudge>[0]> = {}) =>
    longRangeNudge({
        toolName: 'mineTunnel',
        here: { x: 0, z: 0 },
        planText: '去要塞拿 2 根烈焰棒（下界）',
        places: { 要塞: fortress, 家: [12, 63, 1] },
        ...over,
    });

describe('远目标提醒：已删除', () => {
    it('任何输入都不再产出提示（含远目标与交接循环）', () => {
        expect(hintFor()).toBeNull();
        expect(hintFor({ handoffFrom: 'travelTo' })).toBeNull();
        expect(hintFor({ toolName: 'travelTo' })).toBeNull();
        expect(hintFor({ here: null })).toBeNull();
        expect(hintFor({ places: {} })).toBeNull();
    });

    it('目标挑选的纯函数仍保留原行为', () => {
        const target = pickLongRangeTarget({
            toolName: 'mineTunnel',
            here: { x: 0, z: 0 },
            planText: '要塞',
            places: { 要塞: fortress },
        });
        expect(target).not.toBeNull();
        expect(target?.distance).toBeCloseTo(343.4, 0);
        expect(LONG_RANGE_MIN_BLOCKS).toBe(96);

        expect(
            pickLongRangeTarget({
                toolName: 'mineTunnel',
                here: { x: 0, z: 0 },
                planText: '',
                places: { 要塞: fortress, 家: [0, 64, 0] },
            })?.name,
        ).toBe('要塞');
    });

    it('工具名归一化仍保留', () => {
        expect(normalizeToolName('!MineTunnel')).toBe('mineTunnel');
        expect(normalizeToolName('TRAVELTO')).toBe('travelTo');
        expect(normalizeToolName(42)).toBeNull();
    });
});

describe('应用到回执：不再追加任何内容', () => {
    it('null hint 一个字节都不动', () => {
        expect(applyReceiptHint(bodyReceipt, null)).toBe(bodyReceipt);
        expect(applyReceiptHint(bodyReceipt, hintFor())).toBe(bodyReceipt);
    });
});

describe('接线：hint 不再改变回执', () => {
    const runner = {
        run: (): Promise<{ status: 'completed'; data: unknown }> =>
            Promise.resolve({ status: 'completed', data: bodyReceipt }),
    };

    it('传入 hint 也只返回工具自己的回执', async () => {
        const invoke = actionChannelInvoker(runner, { hint: () => hintFor() });
        expect(await invoke('mineTunnel', {})).toBe(`调用 mineTunnel 之后，返回的内容是 ${bodyReceipt}`);
    });

    it('hint 抛错同样不影响回执', async () => {
        const boom = actionChannelInvoker(runner, {
            hint: () => {
                throw new Error('boom');
            },
        });
        expect(await boom('mineTunnel', {})).toBe(`调用 mineTunnel 之后，返回的内容是 ${bodyReceipt}`);
    });
});
