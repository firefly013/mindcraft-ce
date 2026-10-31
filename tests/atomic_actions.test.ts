/**
 * 原子动作：方向换算、键位释放、夹取边界。
 *
 * 这些用例针对的错法**全是静默的**：
 * 东和西按反了照样能走（只是走错方向）、sneak 忘了松手会永远蹲着走、
 * 俯仰没夹住会让视角翻过头。所以拿假身体把这几条钉住。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DIRECTION_YAW,
  describeArrival,
  jump,
  lookInDirection,
  moveBy,
  setPosture,
  turnView,
} from '../src/body/library/skills.js';

/** 一个只记录键位、永远不动的假身体（好让 moveBy 走"卡住"那条结束路径）。 */
function fakeBot(options: { yaw?: number; pitch?: number; onGround?: boolean } = {}) {
    const held = new Set<string>();
    const pressed: string[] = [];
    const released: string[] = [];
    const output = { text: '' };
    const bot: any = {
        output: '',
        entity: {
            yaw: options.yaw ?? 0,
            pitch: options.pitch ?? 0,
            onGround: options.onGround ?? true,
            position: { x: 0, y: 64, z: 0 },
        },
        setControlState: (key: string, down: boolean) => {
            if (down) {
                held.add(key);
                pressed.push(key);
            } else {
                held.delete(key);
                released.push(key);
            }
        },
        look: vi.fn((yaw: number, pitch: number) => {
            bot.entity.yaw = yaw;
            bot.entity.pitch = pitch;
            return Promise.resolve();
        }),
        _held: held,
        _pressed: pressed,
        _released: released,
        _outputRef: output,
    };
    return bot;
}

describe('moveBy：方向换算（mineflayer 约定：yaw 0 面朝北（−Z），90 朝西（−X），180 朝南（+Z））', () => {
    // **yaw 的约定以 mineflayer 源码为准**（lib/plugins/ray_trace.js 的
    // getViewDirection：(-sin·cosP, sinP, -cos·cosP)）：yaw=0 面朝**北（-Z）**，
    // yaw=+90° 面朝**西（-X）**。旧测试按"yaw 0 朝南"写，和引擎相反，
    // 真机 2026-10-23 实测（`move north` 往南走）后才改过来。
    // 这条会连跑 4 次 `moveBy`，而"走不动"的假身体每次都要走完三次起跳尝试
    // （真机语义：卡住才起跳），累计超过了默认 5 秒，所以单独放宽超时。
    it('面朝北（yaw=0）时：forward/north 按 forward，south 按 back，east 按 right', async () => {
        const forward = fakeBot({ yaw: 0 });
        await moveBy(forward, 'forward', 3);
        expect(forward._pressed).toContain('forward');

        const north = fakeBot({ yaw: 0 });
        await moveBy(north, 'north', 3);
        // 面朝北，北就是正前方。
        expect(north._pressed).toContain('forward');

        const south = fakeBot({ yaw: 0 });
        await moveBy(south, 'south', 3);
        expect(south._pressed).toContain('back');

        const east = fakeBot({ yaw: 0 });
        await moveBy(east, 'east', 3);
        // 面朝北时东在右手边。
        expect(east._pressed).toContain('right');
        expect(east._pressed).not.toContain('left');
    }, 30_000);

    it('面朝南（yaw=π）时 forward 就是走南', async () => {
        const bot = fakeBot({ yaw: Math.PI });
        await moveBy(bot, 'forward', 3);
        expect(bot._pressed).toContain('forward');
    });

    it('绝对方向不改朝向（靠按不同的键实现，而不是先转身）', async () => {
        const bot = fakeBot({ yaw: 0 });
        await moveBy(bot, 'east', 3);
        expect(bot.look).not.toHaveBeenCalled();
    });
});

describe('moveBy：一格台阶会自己起跳', () => {
    /**
     * 假身体：**只有按过 jump 才真的往前走 5 格**。
     * 这精确复现真机里的位置——`move(east, 64)` 走 4.9 格就卡住，
     * 挡路的是**一格高的土坎**，裸按键不会自动起跳。
     */
    function stepBot(): any {
        const bot = fakeBot({ yaw: 0 });
        let jumped = false;
        const originalSet = bot.setControlState;
        bot.setControlState = (key: string, down: boolean) => {
            originalSet(key, down);
            if (key === 'jump' && down) jumped = true;
        };
        Object.defineProperty(bot.entity, 'position', {
            get: () => ({ x: jumped ? 5 : 0, y: 64, z: 0 }),
        });
        return bot;
    }

    it('卡住后起跳 → 越过台阶，走满目标距离', async () => {
        const bot = stepBot();
        const ok = await moveBy(bot, 'east', 3);
        expect(ok).toBe(true);
        expect(bot._pressed).toContain('jump');
        expect(bot._held.size).toBe(0); // 跳跃键也必须松开，否则会一直弹
    });

    it('真的走不动时只跳有限次就收手（不在墙前面一直弹）', async () => {
        const bot = fakeBot({ yaw: 0 }); // 永远不动
        const ok = await moveBy(bot, 'east', 3);
        expect(ok).toBe(false);
        // MAX_JUMP_TRIES = 3：跳三次，然后如实报"没迈开步"。
        expect(bot._pressed.filter((k: string) => k === "jump")).toHaveLength(3);
        expect(bot._held.size).toBe(0);
        expect(bot.output).toContain('没迈开步');
    });
});

describe('moveBy：键位一定被释放', () => {
    it('卡住结束时所有键都松开（否则会永远朝一个方向走）', async () => {
        const bot = fakeBot({ yaw: 0 });
        const ok = await moveBy(bot, 'forward', 30);
        expect(ok).toBe(false); // 假身体不动 → 走不满
        expect(bot._held.size).toBe(0);
        expect(bot._released).toContain('forward');
    });

    it('sneak 模式走完会站起（键位随这次移动一起释放）', async () => {
        const bot = fakeBot({ yaw: 0 });
        await moveBy(bot, 'forward', 3, 'sneak');
        expect(bot._pressed).toContain('sneak');
        expect(bot._held.size).toBe(0);
        expect(bot._released).toContain('sneak');
    });

    it('距离越界直接拒绝，一个键都不按', async () => {
        const bot = fakeBot({ yaw: 0 });
        expect(await moveBy(bot, 'forward', 0)).toBe(false);
        expect(await moveBy(bot, 'forward', 65)).toBe(false);
        expect(bot._pressed).toEqual([]);
    });

    it('不认识的方向报错并列出可用值', async () => {
        const bot = fakeBot({ yaw: 0 });
        expect(await moveBy(bot, '侧着走' as never, 3)).toBe(false);
        expect(String(bot.output)).toContain('不认识的方向');
    });
});

describe('jump：离地即松键，落地才算完成', () => {
    it('跳起后松开跳跃键，并在落地时返回 true', async () => {
        const bot = fakeBot({ onGround: true });
        setTimeout(() => {
            bot.entity.onGround = false;
        }, 20);
        setTimeout(() => {
            bot.entity.onGround = true;
        }, 200);
        const ok = await jump(bot);
        expect(ok).toBe(true);
        expect(bot._released).toContain('jump');
        expect(bot._held.size).toBe(0);
    });

    it('头顶被挡住（一直没离地）时给出可读的失败回执', async () => {
        const bot = fakeBot({ onGround: true });
        const ok = await jump(bot);
        expect(ok).toBe(false);
        expect(String(bot.output)).toContain('跳不起来');
        expect(bot._held.size).toBe(0);
    });
});

describe('视角命令', () => {
    // **这里是 mineflayer 的角度，不是原版 Notchian 的。** mineflayer 的
    // `conversions.fromNotchianYaw(deg) = (π − deg·π/180) mod 2π`，代入四方得：
    // 北 0 / 西 90 / 南 180 / 东 −90。以前写的是 Notchian 表（南 0 / 北 180），
    // 于是 `lookInDirection north` 真的把头转向南。
    it('lookInDirection 的方位角符合 mineflayer 约定（北 0 / 西 90 / 南 180 / 东 −90）', async () => {
        for (const [direction, expected] of [
            ['north', 0],
            ['west', Math.PI / 2],
            ['south', Math.PI],
            ['east', -Math.PI / 2],
        ] as const) {
            const bot = fakeBot();
            expect(await lookInDirection(bot, direction)).toBe(true);
            expect(bot.entity.yaw).toBeCloseTo(expected, 5);
        }
    });

    // pitch **正 = 抬头**：getViewDirection 的 y 分量是 sin(pitch)，
    // bot.lookAt 里 pitch = atan2(delta.y, groundDistance)（目标更高 ⇒ 正）。
    it('up / down 只改俯仰，不动水平朝向（up=+90°，down=−90°）', async () => {
        const bot = fakeBot({ yaw: 145 });
        await lookInDirection(bot, 'up');
        expect(bot.entity.pitch).toBeCloseTo(Math.PI / 2, 5);
        expect(bot.entity.yaw).toBeCloseTo(145, 5);

        await lookInDirection(bot, 'down');
        expect(bot.entity.pitch).toBeCloseTo(-Math.PI / 2, 5);
    });

    // **同一件事的两张表不许冲突**：`move(east)` 走的世界向量和 `lookInDirection east`
    // 转出来的朝向必须真的指着同一边。以前前者是对的（也是 mineflayer 约定），
    // 后者照抄了原版 Notchian 表 ⇒ 南北互换，而且**没有任何测试会发现**。
    it('lookInDirection 的方位表和 move 的世界向量必须指着同一边', () => {
        for (const [name, want] of [
            ['north', { x: 0, z: -1 }],
            ['south', { x: 0, z: 1 }],
            ['east', { x: 1, z: 0 }],
            ['west', { x: -1, z: 0 }],
        ] as const) {
            const yaw = DIRECTION_YAW[name];
            expect(yaw, name).toBeDefined();
            const rad = (yaw as number) * (Math.PI / 180);
            // mineflayer `getViewDirection` 的水平分量
            expect(-Math.sin(rad), `${name}.x`).toBeCloseTo(want.x, 6);
            expect(-Math.cos(rad), `${name}.z`).toBeCloseTo(want.z, 6);
        }
    });

    it('不认识的方位给出可用值清单', async () => {
        const bot = fakeBot();
        expect(await lookInDirection(bot, '斜上方')).toBe(false);
        expect(String(bot.output)).toContain('north');
    });

    it('turnView 转的是增量，且俯仰被夹在 ±90', async () => {
        const bot = fakeBot({ yaw: 10, pitch: 0 });
        await turnView(bot, 15, 30);
        expect(bot.entity.yaw).toBeCloseTo(10 + Math.PI / 12, 5);
        expect(bot.entity.pitch).toBeCloseTo(Math.PI / 6, 5);

        await turnView(bot, 0, 999);
        expect(bot.entity.pitch).toBeCloseTo(Math.PI / 2, 5); // 不许翻过头
    });
});

describe('posture：瞬时状态改变，不是任务', () => {
    it('sneak 会告诉模型怎么站回来（回执要教下一步）', () => {
        const bot = fakeBot();
        const text = setPosture(bot, 'sneak');
        expect(bot._held.has('sneak')).toBe(true);
        expect(text).toContain('stand');
    });

    it('stand 松开潜行键', () => {
        const bot = fakeBot();
        setPosture(bot, 'sneak');
        const text = setPosture(bot, 'stand');
        expect(bot._held.has('sneak')).toBe(false);
        expect(text).toContain('站');
    });

    it('未知姿态列出可用值', () => {
        const bot = fakeBot();
        expect(setPosture(bot, '趴下')).toContain('sneak');
    });
});

/**
 * 找方块要**真的走到能碰到它**，而不是"离它 4 格就算到"。
 *
 * Feedback #7：回执说 `You have reached at -33, 53, -13`，而机器人其实在
 * (-34.5, 50, -13.5)——离目标 3.4 格、目标还在头顶上方 3 格。判定是
 * `distance <= min_distance + 1`，而 `searchForBlock` 传的 min_distance 是 4。
 */
describe('describeArrival：不许把"离 3 格"说成"到了"', () => {
  const botAt = (x: number, y: number, z: number): any => ({ entity: { position: { x, y, z } } });

  it('目标在头顶上方：明说"在头顶上方 3 格"，而不是一句 reached', () => {
    // 真机那一幕：bot 在 (-34.5,50,-13.5)，目标 (-33,53,-13)。
    const text = describeArrival(botAt(-34.5, 50, -13.5), -33, 53, -13, 3.4);
    expect(text).toContain('头顶上方');
    expect(text).toContain('3');
    expect(text).not.toContain('You have reached');
  });

  it('目标在脚下下方：说"脚下下方"', () => {
    const text = describeArrival(botAt(0, 60, 0), 0, 57, 0, 3);
    expect(text).toContain('脚下下方');
  });

  it('同一层（垂直差 ≤1.5 格）：不再提上下，只报距离', () => {
    const text = describeArrival(botAt(3, 60, 0), 0, 60, 0, 3);
    expect(text).toContain('同一层');
    expect(text).not.toContain('上方');
    expect(text).not.toContain('下方');
  });

  it('★ 水平与垂直分开报：两个都是 3 格，对模型是完全不同的两件事', () => {
    const vertical = describeArrival(botAt(0, 60, 0), 0, 63, 0, 3);
    const horizontal = describeArrival(botAt(0, 60, 0), 3, 60, 0, 3);
    expect(vertical).toContain('垂直 3');
    expect(vertical).toContain('水平 0');
    expect(horizontal).toContain('水平 3');
    expect(horizontal).toContain('垂直 0');
  });
});
