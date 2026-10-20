/**
 * **"能力存在 ≠ 能力已接通"** —— 这两行必须真的出现在**请求**里，不能只在单测里成立。
 *
 * 背景（Lead 2026-10-20 的复盘）：重启后抓到的那一帧里，视线行和渲染怀疑行**都没出现**。
 * 其中渲染怀疑行是**对的**（重映射后全部一对一 ⇒ trusted ⇒ 零噪音）；
 * 视线行则要看 pitch：那一帧相机大致平视（天空占上半部本来就正常）⇒ 落在 ±35° 阈值内
 * ⇒ 按设计就是**不说话**。但"按设计"不等于"已接通"，所以这里走**真正组装请求的那条链**：
 *
 *   body.sample() → sampleLiveState → renderLiveState（截图段）→ liveTailFromText
 *     → liveTailHook.beforeRequest → 最后一条 user 消息（文本 + 图片）
 *
 * 断言的是**最后那条消息**，不是中间某个函数的返回值。
 */
import { describe, expect, it } from 'vitest';
import { liveTailHook } from '../src/brain/runtime/loop.js';
import { sampleLiveState } from '../src/body/live_state.js';
import { renderLiveState } from '../src/shared/live_state.js';
import { liveTailFromText } from '../src/brain/runtime/perception.js';

type Handler = (request: { messages: readonly unknown[] }) => { messages: readonly { content: unknown }[] } | undefined;

function stubBot(pitchRad: number, yawRad: number): any {
  return {
    health: 20,
    food: 18,
    foodSaturation: 5,
    oxygenLevel: 20,
    experience: { level: 3, progress: 0.5 },
    entity: {
      id: 1,
      position: { x: 10.5, y: 64, z: -3.2 },
      yaw: yawRad,
      pitch: pitchRad,
      metadata: [0, 0, 0, 0, 0, 0, 0],
      onGround: true,
      velocity: { x: 0, y: 0, z: 0 },
    },
    heldItem: { name: 'diamond_sword', count: 1 },
    inventory: { slots: [] },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 6000 },
    players: {},
    entities: {},
    // 采样用到的读法都给一份（本测试只关心截图/视线两段）
    blockAt: () => null,
    blockAtCursor: () => null,
  };
}

/** 走**与 agent 相同的组装**，再交给真正的 hook。 */
async function requestTextFor(pitchDeg: number, trust: { trusted: boolean; reason: string; line: string } | null): Promise<string> {
  const state = sampleLiveState({
    bot: stubBot((pitchDeg * Math.PI) / 180, 0),
    vision: {
      lastScreenshot: { file: 'screenshot_live.jpg', takenAt: Date.now() },
      lastFrameTrust: trust,
    },
  });
  const tail = liveTailFromText(renderLiveState(state));
  const hook = liveTailHook(
    () => tail,
    async () => 'BASE64JPEG',
  ).handlers as unknown as { beforeRequest: Handler };
  // 带 liveImage 时 hook 是异步的（要现拍图）
  const out = await (hook.beforeRequest({ messages: [] }) as unknown as Promise<{ messages: readonly { content: unknown }[] } | undefined>);
  expect(out).toBeDefined();
  const last = out!.messages.at(-1);
  const content = last?.content;
  // 有图时 content 是数组：文本项 + image 项
  expect(Array.isArray(content)).toBe(true);
  const parts = content as Array<{ type: string; text?: string }>;
  expect(parts.some((p) => p.type === 'image')).toBe(true);
  return parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
}

describe('视线行：在**真实请求**里能出现，也能正确地不出现', () => {
  it('朝天空（pitch −88°）⇒ 最后一条 user 消息里带"朝天空"，且图片也一起发出', async () => {
    const text = await requestTextFor(-88, null);
    expect(text).toContain('当前世界快照');
    expect(text).toContain('Screenshot: screenshot_live.jpg');
    expect(text).toContain('视线：**朝天空**');
    expect(text).toContain('不能用来判断地形');
  });

  it('平视（pitch −10°，正是真机那一帧的量级）⇒ **一个字都不加**（这就是那次"没出现"的原因）', async () => {
    const text = await requestTextFor(-10, null);
    expect(text).toContain('Screenshot: screenshot_live.jpg');
    expect(text).not.toContain('视线：');
    // 但图片照发（不因为不说话就把图吞掉）
    expect(text).toContain('当前世界快照');
  });

  it('渲染怀疑行在**真实请求**里也能出现（trusted=false 时），且排在视线行之后', async () => {
    const text = await requestTextFor(-88, { trusted: false, reason: 'version_skew', line: '⚠️ **这张图的渲染不可全信**：测试用行' });
    const lines = text.split('\n');
    const shot = lines.findIndex((l) => l.startsWith('Screenshot:'));
    expect(shot).toBeGreaterThanOrEqual(0);
    expect(lines[shot + 1]).toContain('视线：');
    expect(lines[shot + 2]).toContain('这张图的渲染不可全信');
  });

  it('可信（trusted=true, line 空）⇒ 请求里没有怀疑行（零噪音在请求层面也成立）', async () => {
    const text = await requestTextFor(0, { trusted: true, reason: 'ok', line: '' });
    expect(text).not.toContain('不可全信');
  });
});

describe('读不到 pitch：请求里必须能看到，不许静默', () => {
  it('pitch 为 null ⇒ 请求里出现"读不到"（和平视的沉默区分开）', async () => {
    const bot = stubBot(0, 0);
    bot.entity.pitch = null; // 模拟读数不可用
    const state = sampleLiveState({
      bot,
      vision: { lastScreenshot: { file: 'screenshot_live.jpg', takenAt: Date.now() } },
    });
    const tail = liveTailFromText(renderLiveState(state));
    const hook = liveTailHook(
      () => tail,
      async () => 'BASE64JPEG',
    ).handlers as unknown as { beforeRequest: Handler };
    const out = await (hook.beforeRequest({ messages: [] }) as unknown as Promise<
      { messages: readonly { content: unknown }[] } | undefined
    >);
    const parts = out!.messages.at(-1)!.content as Array<{ type: string; text?: string }>;
    const text = parts.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n');
    expect(text).toContain('视线：**读不到**');
  });
});
