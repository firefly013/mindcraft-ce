/**
 * 残留界面守护（真机 2026-10-20，overnight_b）：
 * 「一个残留的界面（熔炉 GUI，方块随后被队友挖走了）会让所有移动类动作空转。
 *  `goToSurface` 跑了 61 秒，回执是「还在跑（已 60 秒）」，但 speed 0、位置一格没动。」
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (): string => readFileSync(join(process.cwd(), 'src', 'body', 'mineflayer_body.ts'), 'utf8');

describe('残留界面：动作入口先关、Stop 兜底、关不掉就大声失败', () => {
  it('动作入口：有窗口且不是容器类动作 ⇒ 先 closeStaleWindow 并在回执里说明', () => {
    const code = src();
    expect(code).toContain('const hasWindow = (this.bot as any)?.currentWindow != null;');
    expect(code).toContain("const managesWindow = name === 'useBlock' || name === 'craft' || name === 'smelt';");
    expect(code).toContain('const closed = closeStaleWindow(this.bot);');
    expect(code).toContain('先关掉了**残留界面**');
  });

  it('关不掉 ⇒ 大声失败（REFUSED_RESIDUAL_SCREEN），并指向 Stop，而不是空转', () => {
    const code = src();
    expect(code).toContain("code: 'REFUSED_RESIDUAL_SCREEN'");
    expect(code).toContain('先 `stop()`（Stop 会顺手关界面）');
    expect(code).toContain('继续执行只会空转 60 秒');
  });

  it('Stop 会顺手关界面（模型唯一的控制手段必须能解开死结）', () => {
    const code = src();
    expect(code).toContain("event: 'residual-screen-closed'");
    expect(code).toContain("by: 'stop'");
  });

  it('容器类动作自己管界面，不被入口提前关掉（useBlock/craft/smelt）', () => {
    const code = src();
    expect(code).toContain("const managesWindow = name === 'useBlock' || name === 'craft' || name === 'smelt';");
  });
});
