/**
 * 「这个工具不是干这件事的」提醒（`mineTunnel` 去远目标 ⇒ 用 `travelTo`），
 * **并且由大脑显式顶掉最后一行**。
 *
 * 真机：overnight_b 要去 343 格外的要塞，却一遍遍用 `mineTunnel`（方向要调用方自己保证，
 * 模型又常常没给 direction ⇒ 按朝向猜 ⇒ 挖反）。工具说明里写了，但它不读；**回执它读**。
 *
 * 这一批钉的是 Lead 要的三条性质：
 *   (a) 最后一行**是一条调用**，而且是大脑认为对的那条；
 *   (b) 覆盖必须**说出来**（点名被顶掉的是哪一条），全文只剩**一条**「照做即可」——
 *       悄悄换掉会留下两条互相矛盾的"照抄即可"；
 *   (c) **不覆盖的时候，回执一个字节都不动**（严格相等）。
 * 外加：不该提醒时闭嘴（travelTo / 近目标 / 位置读不到 / 有歧义）、幂等、抛错不影响回执。
 */
import { describe, expect, it } from 'vitest';
import { actionChannelInvoker } from '../src/brain/tools/game_tools.js';
import {
    LONG_RANGE_MIN_BLOCKS,
    NEXT_CALL_PREFIX,
    applyReceiptHint,
    longRangeNudge,
    longRangeNextCall,
    pickLongRangeTarget,
} from '../src/brain/tools/long_range_hint.js';

const fortress: [number, number, number] = [-332, 64, 88];

/** 工具自己给的回执（最后一行是它自己的续跑建议）。 */
const bodyReceipt = [
    'mineTunnel：**沿 -x 净前进 12/32 格**（实测位移 12.0 格：(0, 64, 0) → 现在 (-12, 64, 0)）。',
    '停止原因：时间到（内部预算）主动收手。',
    `${NEXT_CALL_PREFIX}mineTunnel(length=32, direction="-x")`,
].join('\n');

const demoted = '- 工具自己的建议（**不要照做**）：mineTunnel(length=32, direction="-x")';

const hintFor = (over: Partial<Parameters<typeof longRangeNudge>[0]> = {}) =>
    longRangeNudge({
        toolName: 'mineTunnel',
        here: { x: 0, z: 0 },
        planText: '去要塞拿 2 根烈焰棒（下界）',
        places: { 要塞: fortress, 家: [12, 63, 1] },
        ...over,
    });

describe('远目标提醒：内容（纯函数）', () => {
    it('mineTunnel + 计划点名「要塞」+ 343 格外 ⇒ 点名目标、给出 travelTo 调用', () => {
        const hint = hintFor();
        expect(hint).not.toBeNull();
        expect(hint?.note).toContain('343 格外的 要塞');
        expect(hint?.note).toContain('不要照做');
        expect(hint?.note).toContain('mineTunnel 需要你自己保证方向对');
        expect(hint?.nextCall).toBe('travelTo(x=-332, z=88)');
        const target = pickLongRangeTarget({
            toolName: 'mineTunnel',
            here: { x: 0, z: 0 },
            planText: '要塞',
            places: { 要塞: fortress },
        });
        expect(target).not.toBeNull();
        expect(longRangeNextCall(target!)).toBe('travelTo(x=-332, z=88)');
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

describe('覆盖最后一行：三条性质', () => {
    it('(a) 最后一行是**调用**，而且是大脑认为对的那条', () => {
        const out = applyReceiptHint(bodyReceipt, hintFor());
        const last = out.split('\n').at(-1) ?? '';
        expect(last).toBe(`${NEXT_CALL_PREFIX}travelTo(x=-332, z=88)`);
        // "是一条调用"：能照抄的形态（名字(参数)）
        expect(/^下一步（照做即可）：[a-zA-Z]+\(.+\)$/.test(last)).toBe(true);
    });

    it('(b) 覆盖**说出来**了：点名被顶掉的那条，且全文只剩一条「照做即可」', () => {
        const out = applyReceiptHint(bodyReceipt, hintFor());
        expect(out.split(NEXT_CALL_PREFIX)).toHaveLength(2); // 只剩一条
        expect(out).toContain(demoted); // 被顶掉的那条仍可见，且被明确标注
        expect(out).toContain('上面 mineTunnel 那条**不要照做**');
        expect(out.split('\n').at(-2)).toContain('不要照做'); // 说明就在最后一行之前
    });

    it('(c) 不覆盖时**一个字节都不动**（严格相等）', () => {
        for (const hint of [
            null,
            hintFor({ toolName: 'travelTo' }),
            hintFor({ here: { x: -325, z: 88 } }),
            hintFor({ here: null }),
            hintFor({ places: {} }),
        ]) {
            expect(applyReceiptHint(bodyReceipt, hint)).toBe(bodyReceipt);
        }
        // 只有说明、没有 nextCall ⇒ 说明插在最后一行之前，最后一行原样
        const noteOnly = applyReceiptHint(bodyReceipt, { note: '⚠️ 只是说明' });
        expect(noteOnly.split('\n').at(-1)).toBe(`${NEXT_CALL_PREFIX}mineTunnel(length=32, direction="-x")`);
        expect(noteOnly).toContain('⚠️ 只是说明');
    });

    it('工具没给「下一步」行时：说明 + 我们的调用接在末尾；重复应用幂等', () => {
        const noNext = 'mineTunnel：**沿 +x 净前进 0/32 格**（卡住了）。';
        const out = applyReceiptHint(noNext, hintFor());
        expect(out.split('\n').at(-1)).toBe(`${NEXT_CALL_PREFIX}travelTo(x=-332, z=88)`);
        expect(applyReceiptHint(out, hintFor())).toBe(out); // 幂等
        const once = applyReceiptHint(bodyReceipt, hintFor());
        expect(applyReceiptHint(once, hintFor())).toBe(once);
    });
});

describe('接线：hint 抛错绝不影响回执', () => {
    const runner = {
        run: async (): Promise<{ status: 'completed'; data: unknown }> => ({ status: 'completed', data: bodyReceipt }),
    };

    it('正常：最后一行被换成 travelTo，且只剩一条「照做即可」', async () => {
        const invoke = actionChannelInvoker(runner, { hint: () => hintFor() });
        const out = await invoke('mineTunnel', {});
        expect(out.split('\n').at(-1)).toBe(`${NEXT_CALL_PREFIX}travelTo(x=-332, z=88)`);
        expect(out.split(NEXT_CALL_PREFIX)).toHaveLength(2);
    });

    it('hint 抛错 / 返回 null ⇒ 回执**逐字不变**', async () => {
        const boom = actionChannelInvoker(runner, {
            hint: () => {
                throw new Error('boom');
            },
        });
        const safe = await boom('mineTunnel', {});
        expect(safe).toContain(`${NEXT_CALL_PREFIX}mineTunnel(length=32, direction="-x")`);
        expect(safe.split(NEXT_CALL_PREFIX)).toHaveLength(2);

        const none = actionChannelInvoker(runner, { hint: () => null });
        expect(await none('mineTunnel', {})).toBe(`工具 mineTunnel {} → ${bodyReceipt}`);
    });
});
