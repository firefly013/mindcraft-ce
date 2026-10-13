/**
 * 游戏工具的装配：集合、顺序、参数形状都必须与旧实现等价。
 *
 * 等价性用**旧实现自己**当预言机（`brain/tools/advertise.ts` 的 `getOpenAITools`），
 * 不拿新代码跟自己对。
 *
 * 工具声明来自**身体**（`body/commands/registry.ts`）——这正是本文件要钉住的分界：
 * 大脑只吃声明，声明里有多少工具就装多少。
 */
import { describe, expect, it } from 'vitest';
import { getOpenAITools } from '../src/brain/tools/advertise.js';
import { buildGameTools } from '../src/brain/tools/game_tools.js';
import { GAME_COMMANDS, toolDeclarations } from '../src/body/commands/registry.js';

/** 旧广告里的控制工具（新路径下各自成型，不在这里）。 */
const CONTROL = ['Finish', 'Stop', 'Say', 'UpdatePlan', 'Feedback'];

/** 身体握手会报上来的那份声明。 */
const DECLARATIONS = toolDeclarations();

describe('工具集合与顺序', () => {
  it('与旧 getOpenAITools 的广告逐项一致（除控制工具外）', () => {
    const oldNames = getOpenAITools(DECLARATIONS).map((tool) => tool.function.name);
    const expected = oldNames.filter((name) => !CONTROL.includes(name));
    const actual = buildGameTools({ declarations: DECLARATIONS, execute: () => '' }).map((tool) => tool.name);
    expect(actual).toEqual(expected);
  });

  it('顺序与 queryList.concat(actionsList) 相同', () => {
    const names = GAME_COMMANDS.map((command) => command.name.replace(/^!/, ''));
    expect(DECLARATIONS.map((d) => d.name)).toEqual(names);
    expect(buildGameTools({ declarations: DECLARATIONS, execute: () => '' }).map((t) => t.name)).toEqual(names);
  });

  it('不含控制工具（它们在别处成型）', () => {
    const names = buildGameTools({ declarations: DECLARATIONS, execute: () => '' }).map((t) => t.name);
    for (const control of CONTROL) expect(names).not.toContain(control);
  });

  it('没有重名', () => {
    const names = buildGameTools({ declarations: DECLARATIONS, execute: () => '' }).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * 能力协商：**工具的 schema 是身体声明的函数**。
 *
 * 这条机制存在的唯一理由是"将来的 Java 身体支持得少"。如果它退化成一个永远返回
 * 全表的装饰，症状是：模型调一个必然失败的工具，而没有任何地方报错。所以这里
 * 测的不是"函数能过滤"，是"声明里没有的工具真的不出现在 schema 里"。
 */
describe('能力协商：装多少看身体声明', () => {
  it('全表声明 = 装全表', () => {
    expect(buildGameTools({ declarations: DECLARATIONS, execute: () => '' }).length).toBe(GAME_COMMANDS.length);
  });

  it('空声明 = 一个工具都没有（身体什么都不会，就别给工具）', () => {
    expect(buildGameTools({ declarations: [], execute: () => '' })).toEqual([]);
  });

  it('只装声明里有的工具，顺序跟着声明走', () => {
    // 故意**逆着全表顺序**声明，这样"跟着声明走"才有区分度。
    const picked = [DECLARATIONS[0], DECLARATIONS[2], DECLARATIONS[1]];
    const names = buildGameTools({ declarations: picked, execute: () => '' }).map((tool) => tool.name);
    expect(names).toEqual(picked.map((d) => d.name));
    expect(new Set(names).size).toBe(3);
  });

  it('身体没声明的命令不会凭空多出一个工具', () => {
    const stats = DECLARATIONS.find((d) => d.name === 'stats');
    expect(stats).toBeDefined();
    const names = stats == null ? [] : buildGameTools({ declarations: [stats], execute: () => '' }).map((tool) => tool.name);
    expect(names).toEqual(['stats']);
  });
});

describe('参数形状：具名 → 位置 → 具名', () => {
  it('调用时拿回具名参数，形状与旧 executeToolCall 一致', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = buildGameTools({
      declarations: DECLARATIONS,
      execute: (name, args) => {
        seen.push({ name, args });
        return 'ok';
      },
    });
    const move = tools.find((tool) => tool.name === 'goToCoordinates');
    expect(move).toBeDefined();
    // goToCoordinates(x, y, z)
    await move?.execute({ x: 10, y: 64, z: -20 }, {} as never, {} as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('goToCoordinates');
    expect(seen[0]?.args).toEqual({ x: 10, y: 64, z: -20 });
  });

  it('省略的可选参数不写入，让 JS 默认参数生效', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tools = buildGameTools({
      declarations: DECLARATIONS,
      execute: (_name, args) => {
        seen.push(args);
        return 'ok';
      },
    });
    const plan = tools.find((tool) => tool.name === 'getCraftingPlan');
    expect(plan).toBeDefined();
    // 只给 targetItem（quantity 声明了 default: 1，不该被塞进来）
    await plan?.execute({ targetItem: 'oak_planks' }, {} as never, {} as never);
    expect(seen[0]).toEqual({ targetItem: 'oak_planks' });
    expect('quantity' in (seen[0] ?? {})).toBe(false);
  });

  it('未声明的参数被严格丢弃（schema 是 additionalProperties:false）', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tools = buildGameTools({
      declarations: DECLARATIONS,
      execute: (_name, args) => {
        seen.push(args);
        return 'ok';
      },
    });
    const plan = tools.find((tool) => tool.name === 'getCraftingPlan');
    await plan?.execute({ target: 'oak_planks' }, {} as never, {} as never);
    // 参数名是 targetItem；写成 target 会被丢掉——不是被当成 targetItem
    expect(seen[0]).toEqual({});
  });

  it('工具返回的执行结果被渲染成文本回执', async () => {
    const tools = buildGameTools({ declarations: DECLARATIONS, execute: () => ({ hits: 2 }) });
    const any = tools[0];
    expect(any).toBeDefined();
    const result = (await any?.execute({}, {} as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]?.text).toBe('{"hits":2}');
  });
});
