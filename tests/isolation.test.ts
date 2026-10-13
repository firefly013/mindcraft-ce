/**
 * 架构守卫：**身体与大脑的隔离**。
 *
 * 这条测试是这次目录重构的核心验收条件，不是"文件摆得好看不好看"：
 *
 * 1. `src/brain/**` 与 `src/body/**` 之间**不许有任何 import 边**（任一方向）。
 * 2. 更强的一条：从**各自的进程入口**出发做传递闭包——大脑进程加载的模块集合
 *    里不许出现任何身体文件，反之亦然。只看直接 import 会漏掉
 *    "brain → shared/x → body/y" 这种绕一圈的耦合。
 * 3. `src/shared/**` 是两侧共用的契约层，它**不许**依赖任何一侧的实现。
 *
 * 为什么值得用测试挡：进程分离在这份代码里曾经只是**拓扑上的说法**——
 * 大脑 `agent.ts` 为了拿工具声明，一路 import 到了 `skills.ts`，于是大脑进程里
 * 照样躺着整份 mineflayer 代码。这种耦合读代码发现不了（每一行 import 单看都
 * 很合理），只有把闭包算出来才知道漏了。
 *
 * 进程边界上**唯一**允许出现的例外是"拉子进程"的那条路径：
 * `brain/process/body_launcher.ts` 里写死了 `src/body/index.ts` 的 URL。
 * 它不是 import（不会把身体代码拉进大脑进程），但必须钉住它指向哪里。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const norm = (p: string): string => p.replace(/\\/g, '/');
const abs = (rel: string): string => resolve(ROOT, rel);

const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.[^'"]*)\1/g;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(norm(relative(ROOT, full)));
  }
  return out;
}

/** 相对 import → 仓库内实际文件（解析不到返回 null，交给断言去报）。 */
function resolveRelative(fromRel: string, spec: string): string | null {
  const base = resolve(dirname(abs(fromRel)), spec);
  const withoutExt = base.endsWith('.js') ? base.slice(0, -3) : base;
  const candidates = [withoutExt + '.ts', withoutExt + '.d.ts', base, join(base, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return norm(relative(ROOT, candidate));
    } catch {
      // 继续试下一个后缀。
    }
  }
  return null;
}

function relativeImports(fromRel: string): string[] {
  const source = readFileSync(abs(fromRel), 'utf8');
  const specs: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const target = resolveRelative(fromRel, match[2] as string);
    if (target != null) specs.push(target);
  }
  return specs;
}

/** 从入口出发、沿相对 import 走一圈：这个进程会加载哪些仓库内文件。 */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of relativeImports(current)) if (!seen.has(next)) queue.push(next);
  }
  return seen;
}

const inDir = (files: Iterable<string>, dir: string): string[] =>
  [...files].filter((file) => file.startsWith(`${dir}/`)).sort();

describe('隔离守卫：身体与大脑不互相 import', () => {
  it('src/brain/** 里没有任何 import 指向 src/body/**', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(abs('src/brain'))) {
      for (const target of relativeImports(file)) {
        if (target.startsWith('src/body/')) offenders.push(`${file} -> ${target}`);
      }
    }
    expect(offenders, '大脑不许依赖身体实现；共享的东西放 src/shared/').toEqual([]);
  });

  it('src/body/** 里没有任何 import 指向 src/brain/**', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(abs('src/body'))) {
      for (const target of relativeImports(file)) {
        if (target.startsWith('src/brain/')) offenders.push(`${file} -> ${target}`);
      }
    }
    expect(offenders, '身体不许依赖大脑实现；共享的东西放 src/shared/').toEqual([]);
  });

  it('src/shared/** 不依赖任何一侧（契约层必须是叶子）', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(abs('src/shared'))) {
      for (const target of relativeImports(file)) {
        if (target.startsWith('src/body/') || target.startsWith('src/brain/')) {
          offenders.push(`${file} -> ${target}`);
        }
      }
    }
    expect(offenders, 'src/shared 是两侧共用的契约，只能往下依赖，不许往上').toEqual([]);
  });

  it('src/shared/** 里没有 Minecraft 客户端库的影子（连 ambient 声明也不行）', () => {
    // 声明住哪，边界就画在哪：`declare module 'mineflayer'` 这种 ambient 声明
    // 放共享层，等于往后谁都能在大脑侧顺手 import 一个客户端库。
    const clientLibs = /(from|declare module)\s*\(?\s*['"](mineflayer|@nxg-org\/mineflayer|prismarine-|minecraft-data|node-canvas-webgl|vec3)/;
    const offenders = tsFiles(abs('src/shared')).filter((file) => clientLibs.test(readFileSync(abs(file), 'utf8')));
    expect(offenders, 'Minecraft 客户端库的声明与用法都该留在 src/body/ 或 src/brain/').toEqual([]);
  });
});

describe('隔离守卫：进程入口的传递闭包', () => {
  it('大脑进程的闭包里一个身体文件都没有', () => {
    const closure = importClosure('src/brain/index.ts');
    expect(closure.has('src/brain/index.ts')).toBe(true);
    expect(inDir(closure, 'src/body')).toEqual([]);
    // 顺带钉住历史欠债本身：大脑不该把 mineflayer 拉进来。
    const mineflayerUsers = [...closure]
      .filter((file) => /from\s+['"]mineflayer/.test(readFileSync(abs(file), 'utf8')))
      .sort();
    expect(mineflayerUsers, '大脑进程不该加载 mineflayer').toEqual([]);
  });

  it('身体进程的闭包里一个大文件都没有', () => {
    const closure = importClosure('src/body/index.ts');
    expect(closure.has('src/body/index.ts')).toBe(true);
    expect(inDir(closure, 'src/brain')).toEqual([]);
  });

  it('两侧的闭包只共享 src/shared/** 与根配置', () => {
    const brain = importClosure('src/brain/index.ts');
    const body = importClosure('src/body/index.ts');
    const shared = [...brain].filter((file) => body.has(file)).sort();
    for (const file of shared) {
      expect(
        file.startsWith('src/shared/') || file === 'main.ts' || file === 'settings.ts',
        `${file} 同时被两侧加载，但它不在 src/shared/`,
      ).toBe(true);
    }
  });
});

describe('隔离守卫：进程边界只有一条 spawn 路径', () => {
  it('大脑拉的是身体入口文件（URL，不是 import）', () => {
    const launcher = readFileSync(abs('src/brain/process/body_launcher.ts'), 'utf8');
    expect(launcher).toContain("new URL('../../body/index.ts', import.meta.url)");
    expect(launcher).toContain("new URL('../../body/index.js', import.meta.url)");
    // 反向：身体进程入口不由大脑的 import 图触达（否则上面那条闭包测试会红）。
    expect(importClosure('src/brain/index.ts').has('src/body/index.ts')).toBe(false);
  });

  it('身体不认识 MindServer / 模型 SDK（它是纯前端）', () => {
    const closure = importClosure('src/body/index.ts');
    const forbidden = [...closure].filter((file) => /from\s+['"](socket\.io-client|openai|@earendil-works)/.test(readFileSync(abs(file), 'utf8')));
    expect(forbidden, '身体进程不该加载 MindServer 客户端或模型 SDK').toEqual([]);
  });
});
