/**
 * 地点三件套（`getPlaces` / `rememberHere` / `goToRememberedPlace`）。
 *
 * 它们住在大脑侧、真源是会话文档——以前住在身体侧、存在身体进程内存里，
 * 于是有了两个真源：身体重启就丢，模型存完列不出来（Feedback #6），
 * 以及"没有 getPlaces 这个工具"（Feedback #5）。
 *
 * ⚠️ 这里最要紧的一条是**参数签名**：pi-durable 的 `execute(args, api, context)`
 * 第一个参数就是 args。曾经写成 `(toolCallId, args)`，于是读到的是 api 对象，
 * 地名永远是空——而 TypeScript 看不出来（参数 typed 成 unknown）。
 */
import { describe, expect, it } from 'vitest';
import {
  createGetPlacesTool,
  createGoToRememberedPlaceTool,
  createRememberHereTool,
  type PlacesDeps,
} from '../src/runtime/control_tools.js';
import { formatSay, SAY_LINE_LIMIT } from '../src/agent/commands/to_openai_tools.js';

/** 假依赖：内存里存一份，可故意让 write 失败。 */
function fakeDeps(opts: { failWrite?: boolean; here?: { x: number; y: number; z: number } | null } = {}) {
  let places: Record<string, [number, number, number]> = {};
  const goto: Array<[number, number, number]> = [];
  const deps: PlacesDeps = {
    read: () => Promise.resolve({ ...places }),
    write: (next) => {
      if (opts.failWrite === true) return Promise.reject(new Error('磁盘满了'));
      places = { ...next };
      return Promise.resolve();
    },
    here: () => Promise.resolve(opts.here === undefined ? { x: 1, y: 2, z: 3 } : opts.here),
    goto: (x, y, z) => {
      goto.push([x, y, z]);
      return Promise.resolve(`走到 ${x},${y},${z}`);
    },
  };
  return { deps, places: () => places, goto };
}

/** 工具的执行结果：取回给模型看的文本。 */
async function run(tool: ReturnType<typeof createRememberHereTool>, args: unknown): Promise<string> {
  const result: any = await (tool as any).execute(args, {} as any, {} as any);
  return String(result?.content?.[0]?.text ?? '');
}

describe('地点工具：参数签名', () => {
  it('★rememberHere 拿得到 args 里的 name（曾经读成 api 对象，地名永远是空）', async () => {
    const { deps, places } = fakeDeps();
    const text = await run(createRememberHereTool(deps), { name: '铁矿洞' });
    expect(text).toContain('铁矿洞');
    expect(places()['铁矿洞']).toEqual([1, 2, 3]);
  });

  it('goToRememberedPlace 也拿得到 name，并按存的坐标走', async () => {
    const { deps, goto } = fakeDeps();
    const tool = createGoToRememberedPlaceTool(deps);
    await run(createRememberHereTool(deps), { name: '家' });
    const text = await run(tool, { name: '家' });
    expect(goto).toEqual([[1, 2, 3]]);
    expect(text).toContain('走到');
  });
});

describe('地点工具：不许假报成功', () => {
  it('存不进去就报失败——不许出现"回执说存好了，其实没有"', async () => {
    const { deps } = fakeDeps({ failWrite: true });
    const text = await run(createRememberHereTool(deps), { name: '铁矿洞' });
    expect(text).toContain('NOT saved');
  });

  it('读不到当前位置也报失败，而不是存个空坐标', async () => {
    const { deps } = fakeDeps({ here: null });
    const text = await run(createRememberHereTool(deps), { name: '铁矿洞' });
    expect(text).toContain('NOT saved');
  });

  it('没这个地名时把记住的都列出来（模型不用猜）', async () => {
    const { deps } = fakeDeps();
    await run(createRememberHereTool(deps), { name: '铁矿洞' });
    const text = await run(createGoToRememberedPlaceTool(deps), { name: '不知道的地方' });
    expect(text).toContain('铁矿洞');
  });
});

describe('getPlaces：列地名带坐标', () => {
  it('一个都没记住时明说', async () => {
    const { deps } = fakeDeps();
    const result: any = await (createGetPlacesTool(deps) as any).execute({}, {} as any, {} as any);
    expect(String(result.content[0].text)).toBe('（一个都没记住）');
  });

  it('记住的带上坐标', async () => {
    const { deps } = fakeDeps({ here: { x: -40.51, y: 51, z: 7.25 } });
    await run(createRememberHereTool(deps), { name: '铁矿洞' });
    const result: any = await (createGetPlacesTool(deps) as any).execute({}, {} as any, {} as any);
    expect(String(result.content[0].text)).toContain('铁矿洞(-40.5,51,7.3)');
  });
});

/**
 * Say 的字数上限（用户要求）。
 *
 * 游戏内聊天超过 255 字服务端会拒收。以前这里**悄悄截断**（`slice(0,240)+'…'`），
 * 于是模型以为整句都说出去了，其实后半截被丢了——而它从回执里看不出来，
 * 因为回执给的就是截断后的那句。
 *
 * 现在：超了就报错回给模型，让它自己缩短。**不许替它决定丢掉哪半句。**
 */
describe('Say：超长要报错，不许悄悄截断', () => {
  // **用常量，不写死数字**：上限只有一个真源（`SAY_LINE_LIMIT`），
  // 测试写死了就会和它各说各话，而两边不一致时没人会去查哪个是对的。
  it('刚好到上限：放行', () => {
    const shaped = formatSay('あ'.repeat(SAY_LINE_LIMIT));
    expect(shaped.ok).toBe(true);
    expect(Array.from(shaped.line ?? '')).toHaveLength(SAY_LINE_LIMIT);
  });

  it('超一个字：拒绝，并说清超了多少、上限多少', () => {
    const shaped = formatSay('あ'.repeat(SAY_LINE_LIMIT + 1));
    expect(shaped.ok).toBe(false);
    expect(shaped.reason).toContain(String(SAY_LINE_LIMIT + 1));
    expect(shaped.reason).toContain(String(SAY_LINE_LIMIT));
  });

  it('★不许截断：超限时不返回 line（否则模型会以为说完了）', () => {
    const shaped = formatSay('あ'.repeat(SAY_LINE_LIMIT * 2));
    expect(shaped.ok).toBe(false);
    expect(shaped.line).toBeUndefined();
  });

  it('按字符数而不是字节数算：中文一字一格', () => {
    const half = Math.floor(SAY_LINE_LIMIT / 4); // 每句两字，凑到一半
    expect(formatSay('中文'.repeat(half)).ok).toBe(true);
    expect(formatSay('中文'.repeat(SAY_LINE_LIMIT)).ok).toBe(false);
  });

  it('空话依然拒绝', () => {
    expect(formatSay('').ok).toBe(false);
    expect(formatSay('   ').ok).toBe(false);
    expect(formatSay(null).ok).toBe(false);
  });
});
