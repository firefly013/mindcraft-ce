/**
 * 传送落点闸门的契约。
 *
 * `/tp` 是唯一完全绕过寻路的移动方式，所以 pathfinder 平时替我们挡的那些东西
 * （岩浆、火、卡进方块），传送这里得自己再挡一遍。这张表一旦漏项或名字失效，
 * 失败方式是**安静的**——模型照传、机器人照掉血，日志里什么都不算异常。
 */
import { describe, expect, it } from 'vitest';
import minecraftData from 'minecraft-data';
import Vec3 from 'vec3';
import {
  HURTING_BLOCKS,
  landingVerdictFor,
  teleportRefusal,
} from '../src/agent/dangerous_blocks.js';

const MC_VERSION = '1.20.4';
const registry: any = minecraftData(MC_VERSION);

/** 只用目标格造一个假 bot，别的不关心。 */
function botOver(blockName: string | null) {
  return {
    entity: { position: new Vec3(0.5, 70, 0.5) },
    blockAt: (p: { x: number; y: number; z: number }) => {
      const same = Math.floor(p.x) === 5 && Math.floor(p.y) === 64 && Math.floor(p.z) === 5;
      return same && blockName != null ? { name: blockName, metadata: 0 } : { name: 'air', metadata: 0 };
    },
    world: { getBlock: () => null },
  };
}

describe('名单没有写成空判据', () => {
  it('每个名字在当前 MC 版本里都真的存在', () => {
    // 版本升级改了方块名的话，这条会红。宁可红，也不要闸门悄悄失效。
    const missing = HURTING_BLOCKS.filter((n) => registry.blocksByName[n] == null);
    expect(missing, `这些名字在 ${MC_VERSION} 里查不到：${missing.join('、')}`).toEqual([]);
  });

  it('名单非空且无重复', () => {
    expect(HURTING_BLOCKS.length).toBeGreaterThan(0);
    expect(new Set(HURTING_BLOCKS).size).toBe(HURTING_BLOCKS.length);
  });
});

describe('landingVerdictFor', () => {
  it('掉血方块判 hurting', () => {
    for (const name of HURTING_BLOCKS) {
      expect(landingVerdictFor(name), name).toBe('hurting');
    }
  });

  it('空气三兄弟是安全的', () => {
    for (const name of ['air', 'cave_air', 'void_air']) {
      expect(landingVerdictFor(name), name).toBe('safe');
    }
  });

  it('实体方块判 solid（卡进去会窒息）', () => {
    for (const name of ['stone', 'dirt', 'grass_block', 'bedrock', 'oak_log']) {
      expect(landingVerdictFor(name), name).toBe('solid');
    }
  });

  it('水不算 internecine —— 它归另一张网管，别判两次给出两份自相矛盾的回执', () => {
    expect(landingVerdictFor('water')).toBe('safe');
  });

  it('名字像但其实无害的那些被正确排除', () => {
    // 这几个是当初从 1058 个方块里按关键词捞出来、逐个看过才剔除的。
    for (const name of ['fire_coral', 'dead_fire_coral_block', 'snow_block', 'rose_bush', 'anvil']) {
      expect(landingVerdictFor(name)).not.toBe('hurting');
    }
    // 蜘蛛网困得住人但**不掉血**，所以它该是"实体"而不是"掉血"。
    expect(landingVerdictFor('cobweb')).toBe('solid');
  });

  it('取不到名字就放行，不瞎拦', () => {
    expect(landingVerdictFor(null)).toBe('safe');
    expect(landingVerdictFor('')).toBe('safe');
  });
});

describe('teleportRefusal', () => {
  it('传到岩浆上 → 拦，且不给授权通道', () => {
    const text = teleportRefusal(botOver('lava'), 5, 64, 5);
    expect(text).not.toBeNull();
    expect(text).toContain('lava');
    expect(text).toContain('掉血');
    // 掉血方块是硬禁止，不该像水那样提示"去授权"。
    expect(text).not.toContain('allowDangerousOps');
  });

  it('名单里每一项都被拦', () => {
    for (const name of HURTING_BLOCKS) {
      expect(teleportRefusal(botOver(name), 5, 64, 5), name).not.toBeNull();
    }
  });

  it('传到实体方块里 → 拦，理由是窒息', () => {
    const text = teleportRefusal(botOver('stone'), 5, 64, 5);
    expect(text).toContain('窒息');
  });

  it('传到空气 → 放行', () => {
    expect(teleportRefusal(botOver('air'), 5, 64, 5)).toBeNull();
    expect(teleportRefusal(botOver('grass_block'), 5, 60, 5)).toBeNull();
  });

  it('传到深水 → 归水那张网管（提示可以授权）', () => {
    // 脚下是水、下面还是水 → 2 格深，危险。
    const bot = {
      entity: { position: new Vec3(0.5, 70, 0.5) },
      blockAt: (p: { x: number; y: number; z: number }) => {
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        const z = Math.floor(p.z);
        if (x === 5 && z === 5 && (y === 64 || y === 63)) return { name: 'water', metadata: 0 };
        if (x === 5 && z === 5 && y === 62) return { name: 'stone', metadata: 0 };
        return { name: 'air', metadata: 0 };
      },
      world: { getBlock: () => null },
    };
    const text = teleportRefusal(bot, 5, 64, 5);
    expect(text).not.toBeNull();
    expect(text).toContain('2 格深');
    expect(text).toContain('allowDangerousOps');
  });

  it('传给没 blockAt 的 bot → 不炸，放行', () => {
    expect(() => teleportRefusal(null, 5, 64, 5)).not.toThrow();
    expect(teleportRefusal({}, 5, 64, 5)).toBeNull();
  });
});
