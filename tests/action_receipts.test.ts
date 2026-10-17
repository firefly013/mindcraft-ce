/**
 * 回执可读性回归：搜索结论、背包增量、交互动作的完成/中断结局。
 *
 * 这些都不是内部实现细节：模型就是靠这些文本判断动作死没死、东西在不在。
 */
import { describe, expect, it } from 'vitest';
import { annotateCollectBlocks, annotateSearchForBlock, movementSummary, parseFoundPosition } from '../src/body/commands/execute.js';
import {
  countInInventoryWithSync,
  findAdjacentStandable,
  formatTransferReceipt,
  planUseBlock,
  runInteractiveAction,
  settleInventory,
} from '../src/body/commands/interact.js';
import { nearestOtherPlayerName, summarizeInventoryGain } from '../src/body/mineflayer_body.js';

describe('searchForBlock 回执', () => {
  it('移动了就说从哪到哪、多少格', () => {
    const text = movementSummary({ x: -1.5, y: 64, z: -5.5 }, { x: -6.4, y: 69, z: -12.5 });
    expect(text).toContain('移动了');
    expect(text).toContain('(-1.5, 64.0, -5.5)');
    expect(text).toContain('(-6.4, 69.0, -12.5)');
  });

  it('没移动就明确说没移动', () => {
    expect(movementSummary({ x: 1, y: 2, z: 3 }, { x: 1.1, y: 2, z: 3 })).toContain('没有移动');
  });

  it('找不到时必须写未找到，并带移动情况', () => {
    const text = annotateSearchForBlock(
      'Could not find any oak_log in 64 blocks.（搜完了，范围内确实没有）',
      { type: 'oak_log', search_range: 64 },
      { x: -1.5, y: 64, z: -5.5 },
      { x: -6.4, y: 69, z: -12.5 },
    );
    expect(text).toContain('未找到');
    expect(text).toContain('oak_log');
    expect(text).toContain('64');
    expect(text).toContain('移动了');
  });

  it('找到了但走不过去：带目标坐标、距离、搜索范围和移动情况', () => {
    const text = annotateSearchForBlock(
      'Found water at (10, 40, 20) but could not reach it (path blocked or too far).',
      { type: 'water', search_range: 64 },
      { x: 0, y: 64, z: 0 },
      { x: 3, y: 64, z: 4 },
    );
    expect(text).toContain('找到了');
    expect(text).toContain('搜索范围 64');
    expect(text).toContain('(10,40,20)');
    expect(text).toContain('离你约');
    expect(text).toContain('移动了');
    expect(parseFoundPosition('Found water at (10, 40, 20) but could not reach it')).toEqual({
      x: 10,
      y: 40,
      z: 20,
    });
  });

  it('空结果不装成成功：说清不能确认，并提 autoPickup', () => {
    const text = annotateSearchForBlock('', { type: 'oak_log', search_range: 32 }, null, null);
    expect(text).toContain('没有得到明确结论');
    expect(text).toContain('autoPickup');
    expect(text).toContain('位置读不到');
  });

  it('384 格搜黑曜石没有结论：不能把 Searching 当最终结果', () => {
    const text = annotateSearchForBlock(
      'Action output:\nSearching for obsidian within 384 blocks...',
      { type: 'obsidian', search_range: 384 },
      { x: 0, y: 64, z: 0 },
      { x: 0, y: 64, z: 0 },
    );
    expect(text).toContain('没有得到明确结论');
    expect(text).toContain('obsidian');
    expect(text).toContain('384');
    expect(text).toContain('没有移动');
    expect(text).not.toBe('Action output:\nSearching for obsidian within 384 blocks...');
  });

  it('384 格搜黑曜石确实没有：明确未找到 + 范围 + 移动', () => {
    const text = annotateSearchForBlock(
      'Could not find any obsidian in 384 blocks.（搜完了，范围内确实没有）',
      { type: 'obsidian', search_range: 384 },
      { x: 1, y: 64, z: 2 },
      { x: 5, y: 64, z: 6 },
    );
    expect(text).toContain('未找到');
    expect(text).toContain('obsidian');
    expect(text).toContain('384');
    expect(text).toContain('移动了');
  });

  it('找到了：给坐标和距离', () => {
    const text = annotateSearchForBlock(
      'Found obsidian at (100, 40, 200). Navigating...',
      { type: 'obsidian', search_range: 384 },
      { x: 0, y: 64, z: 0 },
      { x: 0, y: 64, z: 0 },
    );
    expect(text).toContain('找到了');
    expect(text).toContain('(100,40,200)');
    expect(text).toContain('离你约');
    expect(text).toContain('384');
  });
});

describe('collectBlocks 回执统一口径', () => {
  it('技能日志说 Collected 但背包没变：以背包为准，报没有采集到，不再自相矛盾', () => {
    const text = annotateCollectBlocks(
      'Placed torch... Collected 1 iron_ore.\n采集结束：iron_ore 数量没变（仍是 0）。移动 9.4 格——没挖到，可能目标太远或不可及。',
    );
    expect(text).toContain('没有采集到 iron_ore');
    expect(text).toContain('背包 0 → 0');
    expect(text).toContain('以背包账目为准');
    expect(text).not.toContain('已采集到');
    expect(text).toContain('stats');
  });

  it('背包确实增加：按 before→after 报成功', () => {
    const text = annotateCollectBlocks('Collected 1 iron_ore.\n采集完成：iron_ore 背包 2 → 3（+1），移动 4.2 格。');
    expect(text).toContain('已采集到 iron_ore');
    expect(text).toContain('背包 2 → 3');
    expect(text).toContain('+1');
    expect(text).not.toContain('没有采集到');
  });

  it('解析不到背包账目：明确不能确认，不把技能日志当成功', () => {
    const text = annotateCollectBlocks('Placed torch...');
    expect(text).toContain('无法从背包');
    expect(text).toContain('不要仅凭技能内部日志判定成功');
  });
});

describe('useBlock 加工语义', () => {
  it('熔炉只给 input 时明确要求同时给 output，并给正确例子', () => {
    const plan = planUseBlock('furnace', true, false);
    expect(plan.kind).toBe('unsupported');
    if (plan.kind !== 'unsupported') return;
    expect(plan.reason).toContain('必须同时给 input');
    expect(plan.reason).toContain('output');
    expect(plan.reason).toContain('useBlock(type="furnace"');
  });

  it('箱子只给 input 仍然是合法的存入', () => {
    expect(planUseBlock('chest', true, false).kind).toBe('deposit');
  });

  it('熔炉只给 output 是取出产物', () => {
    expect(planUseBlock('furnace', false, true).kind).toBe('withdraw');
  });
});

describe('容器转移回执统一口径', () => {
  it('取出：请求 1 / 容器 15→0 / 背包没动时，不写 x1-x15 矛盾，并提示同步延迟', () => {
    const text = formatTransferReceipt(
      'iron_ingot',
      1,
      'withdraw',
      {
        ok: true,
        detail: 'old verdict should not be the only line',
        containerReadable: true,
        containerBefore: 15,
        containerAfter: 0,
        containerDelta: 15,
        localMoved: 15,
      },
      0,
      0,
    );
    expect(text).toContain('容器：iron_ingot 15 → 0');
    expect(text).toContain('减少 15');
    expect(text).toContain('背包：iron_ingot 0 → 0');
    expect(text).toContain('你请求取出 1 个');
    expect(text).toContain('实际减少 15');
    expect(text).toContain('背包同步延迟');
    expect(text).toContain('以 stats 为准');
    expect(text).not.toContain('（空）');
  });

  it('容器读不到：明确说不能判断空满，不写（空）', () => {
    const text = formatTransferReceipt(
      'iron_ingot',
      15,
      'withdraw',
      {
        ok: false,
        detail: '重开容器失败',
        containerReadable: false,
        containerBefore: 0,
        containerAfter: null,
        containerDelta: null,
        localMoved: 15,
      },
      0,
      15,
    );
    expect(text).toContain('容器读取不可用');
    expect(text).toContain('不能据此判断容器是空还是满');
    expect(text).toContain('背包：iron_ingot 0 → 15');
    expect(text).not.toContain('（空）');
  });

  it('存入：容器和背包账目一致时给核对一致', () => {
    const text = formatTransferReceipt(
      'coal',
      3,
      'deposit',
      {
        ok: true,
        detail: 'ok',
        containerReadable: true,
        containerBefore: 2,
        containerAfter: 5,
        containerDelta: 3,
        localMoved: 3,
      },
      8,
      5,
    );
    expect(text).toContain('容器：coal 2 → 5');
    expect(text).toContain('增加 3');
    expect(text).toContain('背包：coal 8 → 5');
  });

  it('源槽没找到时保留原文案，并补背包读数', () => {
    const text = formatTransferReceipt('iron_ingot', 3, 'withdraw', { ok: false, detail: '容器里没找到 iron_ingot' }, 2, 2);
    expect(text).toContain('容器里没找到 iron_ingot');
    expect(text).toContain('背包：iron_ingot 2 → 2');
  });
});

describe('背包同步等待', () => {
  it('countInInventoryWithSync 会等 waitForTicks 后的新背包', async () => {
    let items: Array<{ name: string; count: number }> = [];
    const bot = {
      waitForTicks: (): Promise<void> => {
        items = [{ name: 'iron_ingot', count: 15 }];
        return Promise.resolve();
      },
      inventory: { items: () => items },
    };
    await expect(countInInventoryWithSync(bot, 'iron_ingot', 1, 200)).resolves.toBe(15);
  });

  it('settleInventory 在没有 waitForTicks 时也能安全等待', async () => {
    await expect(settleInventory({}, 1, 5)).resolves.toBeUndefined();
  });
});

describe('背包增量摘要', () => {
  it('首次记录不编造物品名，也不暗示背包为空', () => {
    const summary = summarizeInventoryGain(null, { birch_log: 5 });
    expect(summary.firstObservation).toBe(true);
    expect(summary.text).toBe('');
    expect(summary.gained).toEqual({});
  });

  it('没变化时 text 为空，调用方应省略事件', () => {
    const summary = summarizeInventoryGain({ birch_log: 5 }, { birch_log: 5 });
    expect(summary.noChange).toBe(true);
    expect(summary.text).toBe('');
  });

  it('有增量时只报增量', () => {
    const summary = summarizeInventoryGain({ birch_log: 5 }, { birch_log: 7, raw_iron: 1 });
    expect(summary.text).toContain('birch_log×2');
    expect(summary.text).toContain('raw_iron×1');
    expect(summary.gained).toEqual({ birch_log: 2, raw_iron: 1 });
  });
});

describe('自动拾取队友提示', () => {
  it('附近有玩家时能拿到名字', () => {
    const bot = {
      entity: { id: 1, position: { x: 0, y: 64, z: 0 } },
      entities: {
        self: { id: 1, name: 'player', username: 'me', position: { x: 0, y: 64, z: 0 } },
        mate: { id: 2, name: 'player', username: 'overnight_b', position: { x: 1, y: 64, z: 0 } },
        far: { id: 3, name: 'player', username: 'far_away', position: { x: 30, y: 64, z: 0 } },
      },
    };
    expect(nearestOtherPlayerName(bot, 8)).toBe('overnight_b');
  });

  it('附近没玩家或读不到实体表就安静返回 null', () => {
    expect(nearestOtherPlayerName(null)).toBeNull();
    expect(nearestOtherPlayerName({ entity: { id: 1, position: { x: 0, y: 0, z: 0 } }, entities: {} })).toBeNull();
  });
});

describe('交互动作的统一结局', () => {
  it('成功时原样带回工具结果', async () => {
    const agent = {
      actions: {
        runAction: async (_label: string, fn: () => Promise<void>) => {
          await fn();
          return { interrupted: false, timedout: false };
        },
      },
    };
    await expect(runInteractiveAction(agent, 'useBlock', () => '看完了：原料槽：空')).resolves.toContain('原料槽');
  });

  it('被中断时明确说被中断，不假装完成', async () => {
    const agent = {
      actions: {
        runAction: async (_label: string, fn: () => Promise<void>) => {
          await fn();
          return { interrupted: true, timedout: false };
        },
      },
    };
    const text = await runInteractiveAction(agent, 'useBlock', () => '不该原样返回');
    expect(text).toContain('被中断');
    expect(text).toContain('autoPickup');
    expect(text).not.toContain('不该原样返回');
  });

  it('空结果也有可行动的回执', async () => {
    const text = await runInteractiveAction({}, 'useBlock', () => '   ');
    expect(text).toContain('没有返回具体结果');
    expect(text).toContain('stats');
  });
});

describe('目标方块不可站立时找相邻落脚点', () => {
  it('返回空气且脚下实心的相邻格', () => {
    const blocks: Record<string, { name: string }> = {
      '0,0,0': { name: 'furnace' },
      '1,0,0': { name: 'air' },
      '1,1,0': { name: 'air' },
      '1,-1,0': { name: 'stone' },
      '-1,0,0': { name: 'stone' },
    };
    const bot = {
      blockAt: (p: { x: number; y: number; z: number }) => blocks[p.x + ',' + p.y + ',' + p.z] ?? { name: 'air' },
    };
    const spots = findAdjacentStandable(bot, 0, 0, 0);
    expect(spots).toContainEqual({ x: 1, y: 0, z: 0 });
    // 石头挡住的方向不能站。
    expect(spots).not.toContainEqual({ x: -1, y: 0, z: 0 });
  });
});
