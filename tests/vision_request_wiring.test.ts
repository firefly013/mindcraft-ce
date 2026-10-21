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
      lastFrameView: { pitch: (pitchDeg * Math.PI) / 180, yaw: 0 },
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
    const state = sampleLiveState({
      bot,
      vision: {
        lastScreenshot: { file: 'screenshot_live.jpg', takenAt: Date.now() },
        // **这一帧的朝向读不到**（不是"身体读不到"）
        lastFrameView: { pitch: null, yaw: 0 },
      },
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

describe('同一帧同源：朝向、文件名、时间戳必须来自**同一次拍摄**', () => {
  it('一次拍摄 = 一条自洽记录：文件名/时间戳/朝向一起进，一起出', async () => {
    const { frameRecordOf } = await import('../src/body/vision/frame_record.js');
    const record = frameRecordOf(
      { file: 'captured_sky.jpg', view: { pitch: -88 * (Math.PI / 180), yaw: 0 } },
      1_234,
    );
    expect(record).toEqual({
      file: 'captured_sky.jpg',
      takenAt: 1_234,
      view: { yaw: 0, pitch: -88 * (Math.PI / 180) },
      color: null, // 这次没量颜色 ⇒ 明确"没测"，不是"彩色"
    });
  });

  it('拍摄记录读不到朝向 ⇒ 记 `null`（回执**什么都不说**，不拿当前姿态顶替）', async () => {
    const { frameRecordOf } = await import('../src/body/vision/frame_record.js');
    // 关键：`null` 不能变成 0（`Number(null) === 0` 会把"没读到"读成"平视"）
    const record = frameRecordOf({ file: 'f.jpg', view: { pitch: null, yaw: undefined } }, 7);
    expect(record?.view).toEqual({ yaw: null, pitch: null });
  });

  it('形状不对（没有文件名/没有时间戳）⇒ 整条作废', async () => {
    const { frameRecordOf } = await import('../src/body/vision/frame_record.js');
    expect(frameRecordOf({ view: { pitch: 0, yaw: 0 } }, 1)).toBeNull();
    expect(frameRecordOf({ file: '' }, 1)).toBeNull();
    expect(frameRecordOf({ file: 'f.jpg' }, Number.NaN)).toBeNull();
    expect(frameRecordOf(null, 1)).toBeNull();
  });

  it('渲染出来的视线行跟着**这一帧**走（同一份记录），不跟着 position 走', async () => {
    const state = sampleLiveState({
      bot: stubBot(0, 0), // 当前平视
      vision: {
        lastScreenshot: { file: 'f.jpg', takenAt: Date.now() },
        lastFrameView: { pitch: -88 * (Math.PI / 180), yaw: 0 }, // 这一帧朝天空
      },
    });
    const text = renderLiveState(state);
    expect(text).toContain('视线：**朝天空**');
  });
});

describe('裁决进真实请求（不只进渲染函数）', () => {
  it('不可用的帧 ⇒ 最后一条 user 消息的 Screenshot 行里就有裁决', async () => {
    const state = sampleLiveState({
      bot: stubBot(0, 0),
      vision: {
        lastScreenshot: { file: 'frame_bad.jpg', takenAt: Date.now() },
        lastFrameTrust: {
          trusted: false,
          reason: 'version_skew',
          usable: false,
          verdict: '—— **这张图不可信**（渲染器 1.21.4 vs 世界 1.21.11，只有 12% 的方块一对一）：**不要用它认方块**，用下面的 near key blocks 方块数据。',
          line: '',
        },
        lastFrameView: { pitch: 0.05, yaw: 0 },
      },
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
    const head = text.split('\n').find((l) => l.startsWith('Screenshot:')) ?? '';
    expect(head).toContain('这张图不可信');
    expect(head).toContain('12%');
    expect(head).toContain('不要用它认方块');
  });
});

describe('颜色统计（尾部/覆盖率）：平均低 ≠ 没颜色', () => {
  const makeFrame = (colouredShare: number, w = 20, h = 20): Uint8Array => {
    const buf = new Uint8Array(w * h * 4);
    const total = w * h;
    const coloured = Math.round(total * colouredShare);
    for (let i = 0; i < total; i++) {
      const at = i * 4;
      if (i < coloured) {
        // "矿石"：橙褐色，彩度 |R−G|+|G−B| = 90+50 = 140
        buf[at] = 200;
        buf[at + 1] = 110;
        buf[at + 2] = 60;
      } else {
        // "浅灰石墙"：几乎无彩度（3+1=4 < 24）
        buf[at] = 133;
        buf[at + 1] = 130;
        buf[at + 2] = 131;
      }
      buf[at + 3] = 255;
    }
    return buf;
  };

  it('B 的那一帧：灰墙为主 + 8% 彩色矿 ⇒ **不判灰**（平均可以很低）', async () => {
    const { chromaStatsOf, colorFromStats } = await import('../src/body/vision/frame_record.js');
    const stats = chromaStatsOf(makeFrame(0.08), 20, 20, 1)!;
    expect(stats.colouredFraction).toBeGreaterThanOrEqual(0.05); // 尾部有意义
    expect(stats.mean).toBeLessThan(25); // 平均确实被灰墙拉低了
    const color = colorFromStats(stats)!;
    expect(color.grayscale).toBe(false); // 但结论必须是"有颜色"
  });

  it('纯灰（0% 彩色）⇒ 判灰，且三个数字都在', async () => {
    const { chromaStatsOf, colorFromStats } = await import('../src/body/vision/frame_record.js');
    const stats = chromaStatsOf(makeFrame(0), 20, 20, 1)!;
    const color = colorFromStats(stats)!;
    expect(color.colouredFraction).toBe(0);
    expect(color.grayscale).toBe(true);
    expect(typeof color.mean).toBe('number');
    expect(typeof color.p95).toBe('number');
  });

  it('饱和帧（全部彩色）⇒ 不判灰、p95 高', async () => {
    const { chromaStatsOf, colorFromStats } = await import('../src/body/vision/frame_record.js');
    const stats = chromaStatsOf(makeFrame(1), 20, 20, 1)!;
    const color = colorFromStats(stats)!;
    expect(color.grayscale).toBe(false);
    expect(color.p95).toBeGreaterThan(100);
  });

  it('坏输入 ⇒ null（不猜"应该是彩色"）', async () => {
    const { chromaStatsOf, colorFromStats } = await import('../src/body/vision/frame_record.js');
    expect(chromaStatsOf(null, 8, 8)).toBeNull();
    expect(chromaStatsOf(new Uint8Array(4), 8, 8)).toBeNull();
    expect(chromaStatsOf(new Uint8Array(8 * 8 * 4), 0, 8)).toBeNull();
    expect(colorFromStats(null)).toBeNull();
  });

  it('frameRecordOf 把颜色统计一起记下（没测 ⇒ null）', async () => {
    const { frameRecordOf } = await import('../src/body/vision/frame_record.js');
    const withColor = frameRecordOf(
      { file: 'f.jpg', view: { pitch: 0, yaw: 0 }, color: { mean: 2.7, p95: 3, colouredFraction: 0.004 } },
      5,
    );
    expect(withColor?.color).toEqual({ mean: 2.7, p95: 3, colouredFraction: 0.004, grayscale: true });
    const withoutColor = frameRecordOf({ file: 'f.jpg', view: { pitch: 0, yaw: 0 } }, 5);
    expect(withoutColor?.color).toBeNull();
  });
});
