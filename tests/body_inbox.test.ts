/**
 * 开发者通道读取的回归测试。
 *
 * 这些案例全部来自真机：`printf '...' > inbox.txt` 是**截断重写**，
 * 而第一版实现假设文件只增不改，于是三条消息每条都只剩下尾部。
 */
import { describe, expect, it } from 'vitest';
import { decodeCursor, EMPTY_CURSOR, encodeCursor, readInbox, type InboxCursor } from '../src/body/inbox.js';

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

/** 连续投递：把若干次"文件此刻的全部内容"喂进去，返回每次投出的行。 */
function runAppends(contents: string[]): string[][] {
  let cursor: InboxCursor = EMPTY_CURSOR;
  return contents.map((content) => {
    const read = readInbox(buf(content), cursor);
    cursor = read.cursor;
    return read.lines;
  });
}

describe('readInbox', () => {
  it('第一次读到整行', () => {
    expect(runAppends(['你好呀\n'])).toEqual([['你好呀']]);
  });

  it('追加只投新增的行', () => {
    expect(runAppends(['第一行\n', '第一行\n第二行\n'])).toEqual([['第一行'], ['第二行']]);
  });

  it('没有换行的尾巴不投递，也不推进游标', () => {
    // 写到一半就被读到：这半行必须留着，不能当完整消息发出去
    const [first] = runAppends(['半行没写完']);
    expect(first).toEqual([]);
  });

  it('半行补齐之后整条投出（多字节字符不被切开）', () => {
    const [first, second] = runAppends(['必须调用工', '必须调用工具，不要输出正文。\n']);
    expect(first).toEqual([]);
    expect(second).toEqual(['必须调用工具，不要输出正文。']);
  });

  it('★截断重写成更长的内容：不能从旧 offset 处读，否则丢掉头部', () => {
    // 真机现象：三条消息每条都只剩下尾部
    const short = '短\n';
    const long = '现在请停下所有动作，只做一件事：用 Say 告诉我你的名字和你的坐标。不要挖矿。\n';
    const [first, second] = runAppends([short, long]);
    expect(first).toEqual(['短']);
    expect(second).toEqual(['现在请停下所有动作，只做一件事：用 Say 告诉我你的名字和你的坐标。不要挖矿。']);
  });

  it('★截断重写成同样长度、不同内容：也要认出来', () => {
    const [first, second] = runAppends(['AAAA\n', 'BBBB\n']);
    expect(first).toEqual(['AAAA']);
    expect(second).toEqual(['BBBB']);
  });

  it('重写后头部落在多字节字符中间，不会切出替换字符', () => {
    const [first, second] = runAppends(['旧内容\n', '别说话，只做一件事：调用 Say 工具，必须调用工具，不要输出正文。\n']);
    expect(first).toEqual(['旧内容']);
    expect(second.join('')).not.toContain('\uFFFD');
    expect(second).toEqual(['别说话，只做一件事：调用 Say 工具，必须调用工具，不要输出正文。']);
  });

  it('空行不投递，但游标照常推进', () => {
    const [first, second] = runAppends(['\n\n', '\n\n第三行\n']);
    expect(first).toEqual([]);
    expect(second).toEqual(['第三行']);
  });

  it('内容被清空后再写新内容，仍能投出', () => {
    const [first, second, third] = runAppends(['甲\n', '', '乙\n']);
    expect(first).toEqual(['甲']);
    expect(second).toEqual([]);
    expect(third).toEqual(['乙']);
  });
});

/**
 * 游标落盘（D-44）：重启不该重放旧指令。
 *
 * 这两条单测真正想拦住的错法是"只存 offset"——那正好把 D-45 那个丢头部的 bug
 * 带回来（截断重写之后，一个孤零零的 offset 落在消息中间）。
 */
describe('游标落盘', () => {
  it('编解码往返不丢信息', () => {
    const cursor = { offset: 1234, prefix: Buffer.from('带头部').toString('base64') };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('存的是 offset + 指纹两件（只存 offset 会带出丢头部的 bug）', () => {
    const raw = encodeCursor({ offset: 10, prefix: 'YWJj' });
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.offset).toBe(10);
    expect(parsed.prefix).toBe('YWJj');
  });

  it('坏数据一律当"没读过"，不抛异常（最坏后果只是重放一次 inbox）', () => {
    expect(decodeCursor('不是 JSON')).toEqual(EMPTY_CURSOR);
    expect(decodeCursor('{}')).toEqual(EMPTY_CURSOR);
    expect(decodeCursor('{"offset":-5,"prefix":7}')).toEqual(EMPTY_CURSOR);
  });

  it('落盘再读回：同一个文件不会被重放', () => {
    const content = Buffer.from('第一句\n第二句\n', 'utf8');
    const first = readInbox(content, EMPTY_CURSOR);
    expect(first.lines).toEqual(['第一句', '第二句']);
    // 模拟"进程重启"：游标从盘上回来，文件没变。
    const restored = decodeCursor(encodeCursor(first.cursor));
    expect(readInbox(content, restored).lines).toEqual([]);
  });
});

/**
 * 中文消息的乱码（`�`）。
 *
 * 真机现象：开发者在 inbox.txt 里写「调用工具，不要输出正文。」，模型收到的是
 * `{"source":"developer","message":"\ufffd具，不要输出正文。"}` —— 第一个字成了
 * 替换字符，而且**每轮都坏**（不是偶发一次）。
 *
 * 根因：游标是字节偏移，但旧实现先 `subarray(offset).toString('utf8')`，再拿
 * `Buffer.byteLength(已完成部分)` 反算下一个偏移。`�` 的 byteLength 是 3，而那个
 * 残字在原文里可能只占 1 字节，**误差每轮累积**，越跳越偏。
 *
 * 修法是全程在 Buffer 上定位换行（"最后一个换行的下一个字节"必然是字符开头），
 * 并对游标做一次边界对齐。下面这组用例锁的就是"中文消息不许出现 `�`"。
 */
describe('readInbox：中文消息不许变乱码', () => {
  const garbled = '\ufffd';

  it('连着追加多条中文消息，条条完整（无替换字符、无漂移）', () => {
    const messages = ['第一条：去挖矿', '第二条：回来吃饭', '第三条：调用工具，不要输出正文。'];
    let content = '';
    const got: string[] = [];
    let cursor = EMPTY_CURSOR;
    for (const message of messages) {
      content += message + '\n';
      const read = readInbox(buf(content), cursor);
      cursor = read.cursor;
      got.push(...read.lines);
    }
    expect(got).toEqual(messages);
    for (const line of got) expect(line).not.toContain(garbled);
  });

  it('一次写多行中文，全部收到且完整', () => {
    const read = readInbox(buf('调用工具，不要输出正文。\n再去挖点木头。\n'), EMPTY_CURSOR);
    expect(read.lines).toEqual(['调用工具，不要输出正文。', '再去挖点木头。']);
  });

  it('游标停在字符中间（旧版本的坏游标）：退到边界，不吐替换字符', () => {
    const content = buf('调用工具，不要输出正文。\n');
    // 「调」是 3 字节（E8 B0 83），把游标放在它的第 2 个字节上。
    const midChar = { offset: 1, prefix: content.subarray(0, 1).toString('base64') };
    const read = readInbox(content, midChar);
    // 宁可从那个字的开头重读一遍，也不给模型一个 `�`。
    expect(read.lines.join('')).not.toContain(garbled);
    expect(read.lines.join('')).toContain('调用工具');
  });

  it('多轮之后游标不漂移：偏移量正好落在最后一个换行之后', () => {
    let content = buf('');
    let cursor = EMPTY_CURSOR;
    for (const message of ['去挖矿', '回来吃饭', '再做一把镐']) {
      content = Buffer.concat([content, buf(message + '\n')]);
      cursor = readInbox(content, cursor).cursor;
      // 游标必须等于"最后一个 \n 的下一个字节"，一分不差。
      expect(cursor.offset).toBe(content.length);
    }
  });

  it('半个字（写到一半）不投递：等到换行再说，且不产生替换字符', () => {
    const full = '调用工具';
    const bytes = buf(full);
    // 只写了前 4 个字节：「调」(3) + 「用」的第 1 个字节。
    const partial = readInbox(bytes.subarray(0, 4), EMPTY_CURSOR);
    expect(partial.lines).toEqual([]);
    // 补齐后再加换行，整句正常到手。
    const done = readInbox(buf(full + '\n'), partial.cursor);
    expect(done.lines).toEqual([full]);
    expect(done.lines[0]).not.toContain(garbled);
  });
});
