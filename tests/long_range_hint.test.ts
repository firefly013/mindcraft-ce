/**
 * 「这个工具不是干这件事的」提醒（`mineTunnel` 去远目标）——**只追加事实，不改回执**。
 *
 * 真机：overnight_b 要去 343 格外的要塞，却一遍遍用 `mineTunnel`（方向要调用方自己保证，
 * 模型又常常没给 direction ⇒ 按朝向猜 ⇒ 挖反）。工具说明里写了，但它不读；**回执它读**。
 *
 * 2026-10-30 用户裁定：大脑不再替模型改写工具证据（以前会把工具那条「下一步」降级成
 * "不要照做"，再顶上一句我们写的 travelTo 调用）。现在的契约只有三条：
 *   (a) 该提醒时**只追加一段说明**（目标在哪、多远、这个工具需要调用方保证方向）；
 *   (b) 不给"该调哪个工具"；
 *   (c) 不该提醒时，回执**一个字节都不动**（严格相等）；重复应用幂等。
 * 外加：抛错绝不影响回执。
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

/** 工具自己给的回执（内容现在是事实，不再有「下一步」）。 */
const bodyReceipt = [
    'mineTunnel：**沿 -x 净前进 12/32 格**（实测位移 12.0 格：(0, 64, 0) → 现在 (-12, 64, 0)）。',
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

describe('远目标提醒：内容（纯函数）', () => {
    it('mineTunnel + 计划点名「要塞」+ 343 格外 ⇒ 点名目标与距离，但**不给调用**', () => {
        const hint = hintFor();
        expect(hint).not.toBeNull();
        expect(hint?.note).toContain('343 格外的 要塞');
        expect(hint?.note).toContain('mineTunnel 要你自己保证方向对');
        // 2026-10-30：不替模型选工具
        expect(hint?.note).not.toContain('travelTo');
        expect(hint?.note).not.toContain('不要照做');

        const target = pickLongRangeTarget({
            toolName: 'mineTunnel',
            here: { x: 0, z: 0 },
            planText: '要塞',
            places: { 要塞: fortress },
        });
        expect(target).not.toBeNull();
        expect(target!.distance).toBeCloseTo(343.4, 0);
    });

    it('该闭嘴就闭嘴：travelTo / 近目标 / 位置读不到 / 有歧义 / 坐标非法', () => {
        expect(hintFor({ toolName: 'travelTo' })).toBeNull();
        expect(hintFor({ here: { x: -325, z: 88 } })).toBeNull(); // 7 格外
        expect(hintFor({ here: null })).toBeNull();
        expect(hintFor({ planText: '随便挖点下界岩', places: { 要塞: fortress, 另一个门: [400, 64, 400] } })).toBeNull();
        expect(hintFor({ places: { 要塞: [Number.NaN, 64, 88] } })).toBeNull();
        expect(hintFor({ places: {} })).toBeNull();
        expect(LONG_RANGE_MIN_BLOCKS).toBe(96);
    });

    it('只有一个够远的地名 ⇒ 用它；计划点名的优先（多个时取更远的）', () => {
        expect(
            pickLongRangeTarget({
                toolName: 'mineTunnel',
                here: { x: 0, z: 0 },
                planText: '',
                places: { 要塞: fortress, 家: [0, 64, 0] },
            })?.name,
        ).toBe('要塞');
        expect(
            pickLongRangeTarget({
                toolName: 'mineTunnel',
                here: { x: 0, z: 0 },
                planText: '先去要塞，然后回另一个门',
                places: { 要塞: fortress, 另一个门: [400, 64, 400] },
            })?.name,
        ).toBe('另一个门');
    });
});

describe('应用到回执：只追加，不改写', () => {
    it('(a) 追加一段说明，**原有内容逐字保留**（含工具自己的任何一行）', () => {
        const out = applyReceiptHint(bodyReceipt, hintFor());
        expect(out.startsWith(bodyReceipt)).toBe(true);
        expect(out.split('\n').at(-1)).toContain('343 格外的 要塞');
        // 不再有任何"下一步"被塞进来
        expect(out).not.toContain('照做即可');
    });

    it('(b) 不该提醒时**一个字节都不动**（严格相等）', () => {
        for (const hint of [
            null,
            hintFor({ toolName: 'travelTo' }),
            hintFor({ here: { x: -325, z: 88 } }),
            hintFor({ here: null }),
            hintFor({ places: {} }),
        ]) {
            expect(applyReceiptHint(bodyReceipt, hint)).toBe(bodyReceipt);
        }
    });

    it('(c) 重复应用幂等（不会追加两遍）', () => {
        const once = applyReceiptHint(bodyReceipt, hintFor());
        expect(applyReceiptHint(once, hintFor())).toBe(once);
    });
});

describe('交接循环：只报"两边都不动"这个事实', () => {
    it('handoffFrom="travelTo" ⇒ 说明是踢皮球，仍不给调用', () => {
        const hint = hintFor({ handoffFrom: 'travelTo' });
        expect(hint).not.toBeNull();
        expect(hint?.note).toContain('两个工具在互相踢皮球');
        expect(hint?.note).not.toContain('stats(');
        expect(hint?.note).not.toContain('travelTo(x=');
    });

    it('handoff 大小写/前导 ! 都认；别的工具名当没给', () => {
        for (const raw of ['travelTo', '!travelTo', 'TRAVELTO']) {
            expect(hintFor({ handoffFrom: raw })?.note, raw).toContain('踢皮球');
        }
        for (const raw of ['mineTunnel', 'goToCoordinates', '', null]) {
            expect(hintFor({ handoffFrom: raw })?.note, String(raw)).toContain('343 格外的 要塞');
        }
        expect(normalizeToolName('!MineTunnel')).toBe('mineTunnel');
        expect(normalizeToolName(42)).toBeNull();
    });
});

describe('接线：hint 抛错绝不影响回执', () => {
    const runner = {
        run: async (): Promise<{ status: 'completed'; data: unknown }> => ({ status: 'completed', data: bodyReceipt }),
    };

    it('正常：说明追加在末尾，原回执不动', async () => {
        const invoke = actionChannelInvoker(runner, { hint: () => hintFor() });
        const out = await invoke('mineTunnel', {});
        expect(out).toContain(bodyReceipt);
        expect(out).toContain('343 格外的 要塞');
        expect(out).not.toContain('照做即可');
    });

    it('hint 抛错 / 返回 null ⇒ 回执**逐字不变**', async () => {
        const boom = actionChannelInvoker(runner, {
            hint: () => {
                throw new Error('boom');
            },
        });
        const safe = await boom('mineTunnel', {});
        expect(safe).toContain(bodyReceipt);
        expect(safe).not.toContain('343 格外的');

        const none = actionChannelInvoker(runner, { hint: () => null });
        expect(await none('mineTunnel', {})).toBe(`工具 mineTunnel {} → ${bodyReceipt}`);
    });
});
