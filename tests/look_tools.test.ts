/**
 * task-31：朝向工具真的调 bot.look（弧度），回执带 before→after。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  anglesToPoint,
  faceTarget,
  lookAtCoordinates,
  lookInDirection,
  setLookDegrees,
  turnView,
} from '../src/body/library/skills.js';

function fakeBot(): any {
  const bot: any = {
    output: '',
    interrupt_code: false,
    entity: {
      yaw: 0,
      pitch: 0,
      eyeHeight: 1.62,
      position: {
        x: 0,
        y: 0,
        z: 0,
        offset(dx: number, dy: number, dz: number) {
          return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
        },
      },
    },
    look: vi.fn((yaw: number, pitch: number) => {
      bot.entity.yaw = yaw;
      bot.entity.pitch = pitch;
      return Promise.resolve();
    }),
    blockAtCursor: () => ({ name: 'stone', position: { x: 1, y: 0, z: 0 } }),
  };
  return bot;
}

describe('朝向工具', () => {
  it('turnView 用弧度调用 bot.look，并把 before→after 写进回执', async () => {
    const bot = fakeBot();
    await turnView(bot, 90, 0);
    expect(bot.look).toHaveBeenCalledTimes(1);
    expect(bot.look.mock.calls[0][0]).toBeCloseTo(Math.PI / 2, 5);
    expect(bot.look.mock.calls[0][1]).toBeCloseTo(0, 5);
    expect(bot.output).toContain('视角转了');
    expect(bot.output).toContain('0.0° → 90.0°');
  });

  it('lookInDirection north 用 π 弧度', async () => {
    const bot = fakeBot();
    await lookInDirection(bot, 'north', 0);
    expect(bot.look.mock.calls[0][0]).toBeCloseTo(Math.PI, 5);
    expect(bot.output).toContain('朝 north');
  });

  it('lookAtCoordinates 真正面向坐标并带准星校验', async () => {
    const bot = fakeBot();
    const text = await lookAtCoordinates(bot, 0, 0, 5);
    expect(bot.look).toHaveBeenCalledTimes(1);
    expect(bot.entity.yaw).not.toBe(0);
    expect(text).toContain('看向 (0,0,5)');
    expect(text).toContain('yaw');
    expect(text).toContain('准星');
  });

  it('anglesToPoint 与 mineflayer lookAt 公式一致', () => {
    const bot = fakeBot();
    const angles = anglesToPoint(bot, { x: 0.5, y: 0.5, z: 5.5 });
    expect(angles.yawRad).toBeCloseTo(Math.atan2(-0.5, -5.5), 5);
    expect(angles.pitchRad).toBeCloseTo(Math.atan2(0.5 - 1.62, Math.hypot(0.5, 5.5)), 5);
  });

  it('faceTarget 会在交互前自动转向目标', async () => {
    const bot = fakeBot();
    await faceTarget(bot, { x: 3.5, y: 0.5, z: 0.5 }, '箱子');
    expect(bot.look).toHaveBeenCalledTimes(1);
    expect(bot.output).toContain('自动面向 箱子');
    expect(bot.output).toContain('→');
  });

  it('setLookDegrees 返回 before/after 读数', async () => {
    const bot = fakeBot();
    const result = await setLookDegrees(bot, 45, -20, true);
    expect(result.beforeYaw).toBe(0);
    expect(result.afterYaw).toBeCloseTo(45, 1);
    expect(result.afterPitch).toBeCloseTo(-20, 1);
  });
});
