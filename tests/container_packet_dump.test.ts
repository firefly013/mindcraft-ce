/**
 * 容器包转储：只在"开容器"期间武装、有界、脱敏、最后落**一行**日志。
 *
 * 要回答的两个问题（真机 2026-10-19：chest/furnace 18/18 windowOpen 超时，
 * crafting_table 完全正常）：
 *   (a) 服务端到底有没有发 `open_screen` / `window_items`？
 *   (b) 我们到底发了什么（`block_place` / `use_item_on` 的位置、朝向、sequence、手持）？
 *
 * 纪律：**不常开**（不武装就什么都不记）、成功即解除、最多 24 条 / 8 秒。
 */
import { describe, expect, it, vi } from 'vitest';
import { MineflayerBody } from '../src/body/mineflayer_body.js';
import { openBlockUi, resetContainerOpenFailures } from '../src/body/library/skills.js';

function bareBody(): any {
  const body: any = Object.create(MineflayerBody.prototype);
  const handlers: Record<string, Array<(...args: any[]) => void>> = {};
  const client: any = {
    on: (event: string, cb: (...args: any[]) => void) => {
      handlers[event] = [...(handlers[event] ?? []), cb];
    },
    removeListener: (event: string, cb: (...args: any[]) => void) => {
      handlers[event] = (handlers[event] ?? []).filter((h) => h !== cb);
    },
    write: vi.fn(),
    _handlers: handlers,
  };
  body.bot = { _client: client };
  body.containerDumpArmed = false;
  body.containerDumpTimer = null;
  body.containerDumpLines = [];
  body.containerDumpRestore = null;
  body.onContainerIncoming = null;
  body.log = { with: () => ({ info: (payload: any) => logs.push(payload) }) };
  const logs: any[] = [];
  body._logs = logs;
  return body;
}

describe('容器包转储：失败时才留证据，落一行', () => {
  it('武装后记下"我们发了什么"和"服务端回了什么"，收尾只有一行', () => {
    const body = bareBody();
    const client = body.bot._client;
    body.armContainerPacketDump('useBlock chest');
    // 我们的发包（真实路径：block_place 带 location/direction/hand/cursor/sequence）
    client.write('block_place', { location: { x: 9, y: 62, z: 0 }, direction: 1, hand: 0, cursorX: 8, cursorY: 8, cursorZ: 8, sequence: 0 });
    // 服务端没回任何窗口包 → 到期收尾
    body.finishContainerPacketDump('window-expired');
    expect(body._logs).toHaveLength(1);
    const line = body._logs[0];
    expect(line.event).toBe('container-packet-dump');
    expect(line.outcome).toBe('window-expired');
    expect(line.lines.join(' | ')).toContain('out:block_place(9,62,0 dir=1 seq=0 hand=0 cur=8,8,8)');
    expect(line.lines.join(' | ')).not.toContain('in:');
  });

  it('服务端真的发了 open_screen ⇒ 立刻收尾（outcome=window-arrived），不再等超时', () => {
    const body = bareBody();
    body.armContainerPacketDump('useBlock chest');
    body.onContainerIncoming?.({}, { name: 'open_screen' });
    expect(body._logs).toHaveLength(1);
    expect(body._logs[0].outcome).toBe('window-arrived');
    expect(body._logs[0].lines.join(' | ')).toContain('in:open_screen');
  });

  it('不武装就什么都不记（正常游戏不许常开）', () => {
    const body = bareBody();
    body.onContainerIncoming?.({}, { name: 'open_screen' });
    expect(body._logs).toHaveLength(0);
  });

  it('有界：最多 24 条，收尾只发一次日志（重复 finish 无害）', () => {
    const body = bareBody();
    body.armContainerPacketDump('useBlock chest');
    for (let i = 0; i < 40; i++) body.onContainerIncoming?.({}, { name: 'window_items' });
    const line = body._logs[0];
    expect(line.lines.length).toBeLessThanOrEqual(25); // reason + ≤24 条
    body.finishContainerPacketDump('window-expired');
    expect(body._logs).toHaveLength(1);
  });

  it('收尾后 write 被还原（转储不许改掉正常发包路径）', () => {
    const body = bareBody();
    const client = body.bot._client;
    const original = client.write;
    body.armContainerPacketDump('useBlock chest');
    expect(client.write).not.toBe(original); // 期间是包过的
    body.finishContainerPacketDump('opened');
    expect(client.write).toBe(original); // 收尾后还原
  });
});

describe('接线：openBlockUi 只在开容器时武装、成功即解除', () => {
  it('命中 arm，成功后 disarm(opened)', async () => {
    resetContainerOpenFailures();
    const arm = vi.fn();
    const disarm = vi.fn();
    const bot: any = {
      output: '',
      currentWindow: null,
      openContainer: async () => ({ kind: 'container' }),
      __armContainerPacketDump: arm,
      __disarmContainerPacketDump: disarm,
    };
    await openBlockUi(bot, { name: 'chest', position: { x: 1, y: 2, z: 3 } });
    expect(arm).toHaveBeenCalledTimes(1);
    expect(String(arm.mock.calls[0][0])).toContain('chest');
    expect(disarm).toHaveBeenCalledWith('opened');
  });

  it('没有转储入口的 bot 也能正常开（解耦）', async () => {
    resetContainerOpenFailures();
    const bot: any = { output: '', currentWindow: null, openContainer: async () => ({ kind: 'container' }) };
    await expect(openBlockUi(bot, { name: 'chest', position: { x: 1, y: 2, z: 3 } })).resolves.toMatchObject({
      kind: 'container',
    });
  });
});
