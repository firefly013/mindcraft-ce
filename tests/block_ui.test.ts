/**
 * 打开方块界面的**分路**，以及窗口标题的归一化。
 *
 * 这两条都是真机上出过事的地方，而且错法都很静默/误导：
 * - 拿 `openContainer` 去开熔炉，**必然**抛 `containerToOpen is neither a block nor
 *   an entity`（白名单里没有 furnace）。错误信息把两次修复都带偏过。
 * - `String(window.title)` 把对象变成 `[object Object]`，模型读到的就是这串。
 */
import { describe, expect, it, vi } from 'vitest';
import { craftsForRecipe, openBlockUi } from '../src/body/library/skills.js';
import { readableWindowTitle } from '../src/body/mineflayer_body.js';

function fakeBot() {
    // 不是 async：这两个桩不需要真的 await，写成 async 反而触发 require-await。
    // 调用方 `await` 一个普通值完全合法，`openBlockUi` 的 Promise 语义不受影响。
    const openContainer = vi.fn(() => ({ kind: 'container' }));
    const openFurnace = vi.fn(() => ({ kind: 'furnace' }));
    return { bot: { openContainer, openFurnace } as any, openContainer, openFurnace };
}

describe('openBlockUi：按方块类型分路', () => {
    it('熔炉族走 openFurnace（openContainer 的白名单里没有它们）', async () => {
        for (const name of ['furnace', 'blast_furnace', 'smoker']) {
            const { bot, openContainer, openFurnace } = fakeBot();
            const block = { name };
            await openBlockUi(bot, block);
            expect(openFurnace).toHaveBeenCalledWith(block);
            expect(openContainer).not.toHaveBeenCalled();
        }
    });

    it('箱子族走 openContainer', async () => {
        for (const name of ['chest', 'trapped_chest', 'barrel', 'ender_chest', 'hopper', 'white_shulker_box']) {
            const { bot, openContainer, openFurnace } = fakeBot();
            await openBlockUi(bot, { name });
            expect(openContainer).toHaveBeenCalledTimes(1);
            expect(openFurnace).not.toHaveBeenCalled();
        }
    });

    it('工作台没有"打开"这一说：报人话，而不是把内部变量名抛出去', async () => {
        const { bot } = fakeBot();
        await expect(openBlockUi(bot, { name: 'crafting_table' })).rejects.toThrow(
            /没有"打开界面"这个操作/,
        );
        // 关键：绝不把 mineflayer 的 containerToOpen 那句泄漏给模型。
        await expect(openBlockUi(bot, { name: 'anvil' })).rejects.not.toThrow(/containerToOpen/);
    });

    it('读不到方块类型时也报人话', async () => {
        const { bot } = fakeBot();
        await expect(openBlockUi(bot, null)).rejects.toThrow(/读不到方块类型/);
        await expect(openBlockUi(bot, {})).rejects.toThrow(/读不到方块类型/);
    });
});

describe('readableWindowTitle：别把标题变成 [object Object]', () => {
    it('字符串直接用', () => {
        expect(readableWindowTitle('Furnace')).toBe('Furnace');
    });

    it('JSON 文本（{text:…} / {translate:…}）取出里面的字', () => {
        expect(readableWindowTitle('{"text":"Furnace"}')).toBe('Furnace');
        // 语言键也要说人话：container.furnace → Furnace（模型要的是"是熔炉还是箱子"）。
        expect(readableWindowTitle('{"translate":"container.furnace"}')).toBe('Furnace');
    });

    it('聊天组件对象取 text 字段（真机就是这种形状）', () => {
        expect(readableWindowTitle({ text: 'Crafting' })).toBe('Crafting');
    });

    it('带 toString 的对象用它自己的字符串，而不是 [object Object]', () => {
        expect(readableWindowTitle({ toString: () => 'Large Chest' })).toBe('Large Chest');
    });

    it('实在认不出来也不吐 [object Object]，退到可读兜底', () => {
        const weird = { toString: () => '[object Object]', level: 2 };
        expect(readableWindowTitle(weird)).not.toBe('[object Object]');
        expect(readableWindowTitle(null)).toBe('container');
        expect(readableWindowTitle('')).toBe('container');
    });
});

/**
 * 合成数量的语义：**"想要几个" ≠ "跑几遍配方"**。
 *
 * 这是模型在真机上抓到的最要命的一条：它写 `output="4 oak_planks"`（意思"给我 4 个"），
 * 旧实现当成"跑 4 遍"——吃掉 4 个原木、产出 16 个木板。错得**很静默**：
 * 木板的数量确实变多了，没人会去看原木少了多少。
 */
describe('craftsForRecipe：想要 N 个 ≠ 跑 N 遍', () => {
  it('1 原木 → 4 木板：要 4 个只跑 1 遍（就是那个 ×4 bug）', () => {
    const planks = { result: { count: 4 } };
    expect(craftsForRecipe(planks, 4)).toEqual({ perCraft: 4, runs: 1 });
  });

  it('要 6 个木板得跑 2 遍（向上取整，不能少给）', () => {
    expect(craftsForRecipe({ result: { count: 4 } }, 6).runs).toBe(2);
  });

  it('够整除时不多跑：要 8 个木板正好 2 遍', () => {
    expect(craftsForRecipe({ result: { count: 4 } }, 8).runs).toBe(2);
  });

  it('每遍只出 1 个的配方（如工作台）：要几个跑几遍', () => {
    expect(craftsForRecipe({ result: { count: 1 } }, 3)).toEqual({ perCraft: 1, runs: 3 });
  });

  it('配方没写产出数量时按 1 算，不按 0 算（0 会除出 Infinity）', () => {
    expect(craftsForRecipe({}, 2)).toEqual({ perCraft: 1, runs: 2 });
    expect(craftsForRecipe({ result: { count: 0 } }, 2).runs).toBe(2);
  });

  it('要 0 个或负数：至少跑 1 遍，不跑 0 遍（那是"什么都没发生"）', () => {
    expect(craftsForRecipe({ result: { count: 4 } }, 0).runs).toBe(1);
    expect(craftsForRecipe({ result: { count: 4 } }, -5).runs).toBe(1);
  });
});

/**
 * 容器标题的**第三种形态**（Feedback #19）。
 *
 * 同一个 `window.title` 字段，真机上先后出现过：纯字符串、聊天组件对象（旧代码
 * `String()` 后是 `[object Object]`）、以及这次的**序列化 NBT 复合标签**——
 * `{"type":"compound","value":{"translate":{"type":"string","value":"container.furnace"}}}`。
 * 模型要的只是"我打开的是熔炉还是箱子"，不是这些内部结构。
 */
describe('readableWindowTitle：NBT 复合标签也要读出人话', () => {
  it('★真机那一串：compound > translate > string > container.furnace', () => {
    const raw =
      '{"type":"compound","value":{"translate":{"type":"string","value":"container.furnace"}}}';
    expect(readableWindowTitle(raw)).toBe('Furnace');
  });

  it('聊天组件对象形态（type/value 层层套）', () => {
    expect(
      readableWindowTitle({ type: 'compound', value: { translate: { type: 'string', value: 'container.chest' } } }),
    ).toBe('Chest');
  });

  it('text 优先于 translate：有字面文本就用字面文本', () => {
    expect(
      readableWindowTitle({ type: 'compound', value: { text: { type: 'string', value: '我的箱子' } } }),
    ).toBe('我的箱子');
  });

  it('语言键按下划线分词并首字母大写：container.blast_furnace → Blast furnace', () => {
    expect(readableWindowTitle('container.blast_furnace')).toBe('Blast furnace');
  });

  it('实在解析不出来也不吐内部结构', () => {
    const text = readableWindowTitle({ type: 'compound', value: { nothing: {} } });
    expect(text).not.toContain('[object Object]');
    expect(text.length).toBeLessThan(60);
  });
});
