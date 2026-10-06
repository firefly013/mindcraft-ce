/**
 * 游戏工具的装配：集合、顺序、参数形状都必须与旧实现等价。
 *
 * 等价性用**旧实现自己**当预言机（`getOpenAITools`），不拿新代码跟自己对。
 */
import { describe, expect, it } from 'vitest';
import { getOpenAITools } from '../src/agent/commands/to_openai_tools.js';
import { GAME_COMMANDS, buildGameTools } from '../src/runtime/game_tools.js';

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
