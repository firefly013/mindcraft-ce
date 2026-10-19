/**
 * 「这个工具不是干这件事的」提醒（`mineTunnel` 去远目标 ⇒ 用 `travelTo`）。
 *
 * 真机：overnight_b 要去 380 格外的要塞，却一遍遍用 `mineTunnel`（方向要调用方自己保证，
 * 模型又常常没给 direction ⇒ 按朝向猜 ⇒ 挖反）。工具说明里写了，但它不读；
 * **回执它读**。这一批钉的是：
 *   1) 该提醒的时候提醒，并且**点名目标 + 给出可照抄的 travelTo 坐标**；
 *   2) 不该提醒的时候闭嘴（travelTo 本身、近目标、有歧义的地名）；
 *   3) 提醒插在「下一步」**之前**（回执最后一行必须还是那条能照抄的调用）；
 *   4) 提醒出问题（抛错）绝不影响回执。
 */
import { describe, expect, it } from 'vitest';
import { actionChannelInvoker } from '../src/brain/tools/game_tools.js';
import {
    LONG_RANGE_MIN_BLOCKS,
    longRangeNudge,
    pickLongRangeTarget,
    withLongRangeNudge,
} from '../src/brain/tools/long_range_hint.js';

const fortress: [number, number, number] = [-332, 64, 88];

describe('远目标提醒（纯函数）', () => {
    it('mineTunnel + 计划里点名「要塞」+ 380 格外 ⇒ 点名目标并给出 travelTo 坐标', () => {
        const nudge = longRangeNudge({
            toolName: 'mineTunnel',
            here: { x: 0, z: 0 },
            planText: '去要塞拿 2 根烈焰棒（下界）',
            places: { 要塞: fortress, 家: [0, 64, 0] },
        });

        expect(nudge).not.toBeNull();
        expect(nudge).toContain('去 要塞');
        expect(nudge).toContain('343 格外');
        expect(nudge).toContain('travelTo(x=-332, z=88)');
        expect(nudge).toContain('按坐标算方向');
        expect(nudge).toContain('mineTunnel 需要你自己保证方向对');
    });

    it('travelTo 本来就是干这个的 ⇒ 不提醒', () => {
        expect(
            longRangeNudge({
                toolName: 'travelTo',
                here: { x: 0, z: 0 },
                planText: '去要塞',
                places: { 要塞: fortress },
            }),
        ).toBeNull();
    });

    it('近目标（< 96 格）⇒ 不提醒：mineTunnel 在近处完全合理', () => {
        expect(
            longRangeNudge({
                toolName: 'mineTunnel',
                here: { x: -320, z: 88 },
                planText: '去要塞',
                places: { 要塞: fortress },
            }),
        ).toBeNull();
        expect(LONG_RANGE_MIN_BLOCKS).toBe(96);
    });

    it('**有歧义就不猜**：两个够远的地名、计划里一个都没点名 ⇒ 不提醒', () => {
        expect(
            longRangeNudge({
                toolName: 'mineTunnel',
                here: { x: 0, z: 0 },
                planText: '随便挖点下界岩',
                places: { 要塞: fortress, 另一个门: [400, 64, 400] },
            }),
        ).toBeNull();
    });

    it('只有一个够远的地名 ⇒ 用它（哪怕计划里没点名）', () => {
        const target = pickLongRangeTarget({
            toolName: 'mineTunnel',
            here: { x: 0, z: 0 },
            planText: '',
            places: { 要塞: fortress, 家: [0, 64, 0] },
        });
        expect(target?.name).toBe('要塞');
        expect(Math.round(target?.distance ?? 0)).toBe(343);
    });

    it('计划点名了多个远地名 ⇒ 取计划里那个（远的优先，去要塞不是回家）', () => {
        const target = pickLongRangeTarget({
            toolName: 'mineTunnel',
            here: { x: 0, z: 0 },
            planText: '先去要塞，然后回另一个门',
            places: { 要塞: fortress, 另一个门: [400, 64, 400] },
        });
        expect(target?.name).toBe('另一个门'); // 更远 ⇒ 更可能是"这趟的长途目标"
    });

    it('读不到当前位置 / 坐标不合法 ⇒ 不提醒（不猜）', () => {
        expect(
            longRangeNudge({ toolName: 'mineTunnel', here: null, planText: '去要塞', places: { 要塞: fortress } }),
        ).toBeNull();
        expect(
            longRangeNudge({
                toolName: 'mineTunnel',
                here: { x: 0, z: 0 },
                planText: '去要塞',
                places: { 要塞: [Number.NaN, 64, 88] },
            }),
        ).toBeNull();
        expect(longRangeNudge({ toolName: 'mineTunnel', here: { x: 0, z: 0 }, planText: '', places: {} })).toBeNull();
    });
});

describe('提醒插进回执：位置与容错', () => {
    it('插在最后一行「下一步」**之前**（最后一行必须还是能照抄的调用）', () => {
        const receipt = 'mineTunnel：…\n停止原因：…\n下一步（照做即可）：mineTunnel(length=32, direction="+x")';
        const out = withLongRangeNudge(receipt, '⚠️ 去要塞请用 travelTo(x=-332, z=88)');
        const lines = out.split('\n');

        expect(lines.at(-1)).toBe('下一步（照做即可）：mineTunnel(length=32, direction="+x")');
        expect(lines.at(-2)).toContain('travelTo(x=-332, z=88)');
    });

    it('没有「下一步」行 ⇒ 接在末尾；同一条提醒不重复堆', () => {
        expect(withLongRangeNudge('回执正文', '提醒')).toBe('回执正文\n提醒');
        expect(withLongRangeNudge('回执正文\n提醒', '提醒')).toBe('回执正文\n提醒');
        expect(withLongRangeNudge('回执正文', null)).toBe('回执正文');
    });

    it('`actionChannelInvoker` 的 hint：正常追加；hint 抛错 ⇒ 回执原样返回', async () => {
        const runner = {
            run: async (): Promise<{ status: 'completed'; data: unknown }> => ({
                status: 'completed',
                data: '回执正文\n下一步（照做即可）：mineTunnel(length=32, direction="+x")',
            }),
        };
        const withHint = actionChannelInvoker(runner, { hint: () => '⚠️ 去要塞请用 travelTo(x=-332, z=88)' });
        const ok = await withHint('mineTunnel', {});
        expect(ok.split('\n').at(-1)).toBe('下一步（照做即可）：mineTunnel(length=32, direction="+x")');
        expect(ok).toContain('travelTo(x=-332, z=88)');

        const boom = actionChannelInvoker(runner, {
            hint: () => {
                throw new Error('boom');
            },
        });
        const safe = await boom('mineTunnel', {});
        expect(safe).toContain('回执正文');
        expect(safe.split('\n').at(-1)).toBe('下一步（照做即可）：mineTunnel(length=32, direction="+x")');

        const none = actionChannelInvoker(runner, { hint: () => null });
        const plain = await none('mineTunnel', {});
        expect(plain).toContain('回执正文'); // 外面还有一层「工具 mineTunnel … →」的包装
        expect(plain.split('\n').at(-1)).toBe('下一步（照做即可）：mineTunnel(length=32, direction="+x")');
        expect(plain).not.toContain('travelTo(x=-332');
    });
});
