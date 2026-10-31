/**
 * **回归守卫：引擎里不许再出现"保留物品栏 / 死亡代价"这套概念。**
 *
 * 背景（2026-10 真机）：测试档一度开着 keepInventory，于是代码里长出了一整套
 * "这个档死亡很便宜，所以主动死一次是合法重置"的话术——注释、回执、配置项、
 * 甚至一条"让呼吸反射停手 60 秒以便憋死"的例外。gamerule 关掉之后，这些话全成了
 * 假话，而**回执是模型唯一的输入**：一句"故意死一次是合法选择"等价于一条行为指令，
 * 模型据此真的主动去送死。
 *
 * 用户裁定：**把这段历史整个抹掉，假装从未发生过**——引擎不读这个 gamerule、
 * 不评价死亡划不划算、也不提供任何以死亡为代价的"出口"。
 *
 * 这一条用源码扫描钉住它，防止哪天又被"聪明"地加回来。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.json')) out.push(full);
  }
  return out;
}

/** 这些词一旦出现在 src 里，就说明那套概念又回来了。 */
const FORBIDDEN_IN_SRC: ReadonlyArray<{ needle: string; why: string }> = [
  { needle: 'keepInventory', why: '引擎不再读这个 gamerule（如确需死亡信息，模型能看到掉落清单）' },
  { needle: 'doImmediateRespawn', why: '同上：死亡节奏不是引擎的决策输入' },
  { needle: 'deathCostLine', why: '"死一次多贵"这种话术已整体删除' },
  { needle: 'grantSurfaceMs', why: '已没有任何"故意让保命停手"的放行通道' },
  { needle: 'deadlock', why: '三方互锁例外随"憋死"出口一起删除' },
  { needle: '故意死', why: '回执不许给模型"去死"的建议' },
  { needle: '主动死', why: '回执不许给模型"去死"的建议' },
  { needle: '保留物品栏', why: '世界规则不进入引擎的判断' },
  { needle: '合法的重置', why: '"死亡很便宜"的措辞已整体删除' },
];

describe('死亡代价概念不许回流（源码扫描）', () => {
  const files = walkTs(join(process.cwd(), 'src'));

  it('src 下没有任何文件提到那套概念', () => {
    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const rule of FORBIDDEN_IN_SRC) {
        if (text.includes(rule.needle)) {
          hits.push(`${file.replace(process.cwd() + '\\', '')}: ${rule.needle} —— ${rule.why}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('overnight 启动配置里也没有这个字段（否则等于又在声明世界规则）', () => {
    const settings = readFileSync(join(process.cwd(), 'scripts', 'overnight', 'overnight-settings.json'), 'utf8');
    expect(settings).not.toContain('keepInventory');
    expect(settings).not.toContain('gameplay');
  });
});
