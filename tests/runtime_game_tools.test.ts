/**
 * 游戏工具的装配：集合、顺序、参数形状都必须与旧实现等价。
 *
 * 等价性用**旧实现自己**当预言机（`getOpenAITools`），不拿新代码跟自己对。
 */
import { describe, expect, it } from 'vitest';
import { getOpenAITools } from '../src/body/commands/to_openai_tools.js';
import { GAME_COMMANDS, buildGameTools, commandsForBody } from '../src/brain/tools/game_tools.js';

/** 旧广告里的控制工具（新路径下各自成型，不在这里）。 */
const CONTROL = ['Finish', 'Stop', 'Say', 'UpdatePlan', 'Feedback'];

describe('工具集合与顺序', () => {
  it('与旧 getOpenAITools 的广告逐项一致（除控制工具外）', () => {
    const oldNames = getOpenAITools({}).map((tool) => tool.function.name);
    const expected = oldNames.filter((name) => !CONTROL.includes(name));
    const actual = buildGameTools({ execute: () => '' }).map((tool) => tool.name);
    expect(actual).toEqual(expected);
  });

  it('顺序与 queryList.concat(actionsList) 相同', () => {
    const names = GAME_COMMANDS.map((command) => command.name.replace(/^!/, ''));
    expect(buildGameTools({ execute: () => '' }).map((t) => t.name)).toEqual(names);
  });

  it('不含控制工具（它们在别处成型）', () => {
    const names = buildGameTools({ execute: () => '' }).map((t) => t.name);
    for (const control of CONTROL) expect(names).not.toContain(control);
  });

  it('没有重名', () => {
    const names = buildGameTools({ execute: () => '' }).map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * 能力协商：**工具的 schema 是身体能力的函数**。
 *
 * 这条机制存在的唯一理由是"将来的 Java 身体支持得少"。如果它退化成一个永远返回
 * 全表的装饰，症状是：模型调一个必然失败的工具，而没有任何地方报错。所以这里
 * 测的不是"函数能过滤"，是"少声明的能力真的不出现在 schema 里"。
 */
describe('能力协商过滤', () => {
  const allNames = GAME_COMMANDS.map((command) => command.name.replace(/^!/, ''));

  it('不传 = 全表（测试与"还没有身体"的场景的默认值）', () => {
    expect(commandsForBody()).toEqual(GAME_COMMANDS);
    expect(buildGameTools({ execute: () => '' }).length).toBe(GAME_COMMANDS.length);
  });

  it('空表 = 一个工具都没有（身体什么都不会，就别给工具）', () => {
    expect(commandsForBody([])).toEqual([]);
    expect(buildGameTools({ execute: () => '', commands: [] })).toEqual([]);
  });

  it('子集只保留交集，且顺序跟着全表走（不是跟着声明表走）', () => {
    // 故意**逆着全表顺序**声明，这样"跟着谁走"才有区分度。
    const picked = [allNames[0], allNames[2], allNames[1]];
    const filtered = commandsForBody(picked).map((c) => c.name.replace(/^!/, ''));
    expect(filtered).toEqual([allNames[0], allNames[1], allNames[2]]);
    expect(new Set(filtered).size).toBe(3);
    // 工具顺序是提示词契约的一部分，不能随身体声明的顺序漂。
    expect(filtered).not.toEqual(picked);
  });

  it('身体声明了它没有的命令时，静默忽略而不是凭空多出一个工具', () => {
    const filtered = commandsForBody(['stats', 'thisCommandDoesNotExist']);
    expect(filtered.map((c) => c.name.replace(/^!/, ''))).toEqual(['stats']);
  });

  it('带 `!` 前缀的声明也认（协议上不带，但能力表是手写的）', () => {
    // 多一个感叹号的代价原本是"这个身体静默失去全部工具"——不报错的那种失败。
    expect(commandsForBody(['!stats']).map((c) => c.name.replace(/^!/, ''))).toEqual(['stats']);
  });
});

describe('参数形状：具名 → 位置 → 具名', () => {
  it('调用时拿回具名参数，形状与旧 executeToolCall 一致', async () => {
    const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = buildGameTools({
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
    const tools = buildGameTools({ execute: () => ({ hits: 2 }) });
    const any = tools[0];
    expect(any).toBeDefined();
    const result = (await any?.execute({}, {} as never, {} as never)) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0]?.text).toBe('{"hits":2}');
  });
});
