/**
 * `conversing` 提示词的契约。
 *
 * 提示词就是契约：工具名和流程写在这里，模型照着做。架构改了而提示词没改，
 * 模型就会去调一个不存在的 `Finish`、或者以为"每轮必须调工具"而空转。
 *
 * 这里同时保护**有意设计**：Say + 自动散文双通道不能被当成冗余删掉。
 */
import { describe, expect, it } from 'vitest';
import { PROMPT_SETS } from '../src/prompts.js';

const conversing = PROMPT_SETS['default']?.['conversing'] ?? '';

describe('conversing 提示词契约', () => {
  it('不再教 Finish / 强制工具——那两样已经拆掉', () => {
    expect(conversing).not.toContain('Finish');
    expect(conversing).not.toContain('至少调用一个工具');
  });

  it('自然 ReAct 循环：不需要工具就用正文回答，那一轮就结束', () => {
    expect(conversing).toContain('ReAct');
    expect(conversing).toContain('不需要工具了就直接用正文回答');
    expect(conversing).toContain('一轮可以调多个');
  });

  it('双通道是**有意设计**，必须保留', () => {
    // 散文 = 正文自动发出（干活的动静）；Say = 专门说话的工具
    expect(conversing).toContain('Say');
    expect(conversing).toContain('你的正文也会自动发出来');
  });

  it('Stop 的语义没变：停动作，不结束推理', () => {
    expect(conversing).toContain('Stop 只停下机器人全部动作，不结束推理');
  });

  it('$NAME 占位符保留（由渲染方替换）', () => {
    expect(conversing).toContain('$NAME');
  });

  it('Feedback 通道保留', () => {
    expect(conversing).toContain('Feedback');
  });
});
