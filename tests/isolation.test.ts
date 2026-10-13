/**
 * 架构守卫：**身体与大脑的隔离**。
 *
 * 这条测试是这次目录重构的核心验收条件，不是"文件摆得好看不好看"：
 *
 * 1. `src/brain/**` 与 `src/body/**` 之间**不许有任何 import 边**（任一方向）。
 * 2. 更强的一条：从**各自的进程入口**出发做传递闭包——大脑进程加载的模块集合
 *    里不许出现任何身体文件（也**不加载任何 Minecraft 客户端库**），反之亦然。
 *    只看直接 import 会漏掉 "brain → shared/x → body/y" 这种绕一圈的耦合。
 * 3. `src/shared/**` 是两侧共用的契约层，它**不许**依赖任何一侧的实现，
 *    也不许替任何一侧声明 Minecraft 客户端库。
 * 4. **宿主（main.ts / MindServer）也不许加载身体**：它是第三个进程，
 *    但它管的是"派生大脑"，同样不该把 Mineflayer 拖进来。
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

/** 相对 import（`from 'x'` / `import('x')` / `import 'x'`）与字面量 `require('x')`。 */
const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(norm(relative(ROOT, full)));
  }
  return out;
}

/** import 说明符 → 仓库内实际文件。仓库外（依赖包）返回 null；解析不到的相对路径抛错。 */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
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
  // **解析不到就报错，不许静默跳过**：一条写错的相对 import 会让这个文件
  // 从闭包里消失，于是"闭包里没有身体文件"变成一句空话。
  throw new Error(`${fromRel} 里的相对 import 解析不到文件：${spec}`);
}

/** 一个文件里的（仓库内）import 边。 */
function relativeImports(fromRel: string): string[] {
  const source = readFileSync(abs(fromRel), 'utf8');
  const targets: string[] = [];
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(source)) !== null) {
    const target = resolveSpecifier(fromRel, match[2] as string);
    if (target != null) targets.push(target);
  }
  return targets;
}

/** 从入口出发、沿仓库内 import 走一圈：这个进程会加载哪些仓库内文件。 */
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

/** 闭包里引用到的外部包名（`from 'x'` / `import('x')` / `require('x')`）。 */
function bareImports(closure: Iterable<string>): Set<string> {
  const packages = new Set<string>();
  for (const file of closure) {
    const source = readFileSync(abs(file), 'utf8');
    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const spec = match[2] as string;
      if (spec.startsWith('.') || spec.startsWith('node:')) continue;
      packages.add(spec);
    }
  }
  return packages;
}

const MINECRAFT_CLIENT = /^(mineflayer|@nxg-org\/mineflayer|prismarine-|minecraft-data|node-canvas-webgl|vec3$|canvas$)/;
const HOST_ONLY = /^(express|socket\.io|socket\.io-client|openai|@earendil-works\/)/;

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
  it('大脑进程的闭包里一个身体文件都没有，也不加载 Minecraft 客户端库', () => {
    const closure = importClosure('src/brain/index.ts');
    expect(closure.has('src/brain/index.ts')).toBe(true);
    expect(inDir(closure, 'src/body')).toEqual([]);
    const forbidden = [...bareImports(closure)].filter((spec) => MINECRAFT_CLIENT.test(spec)).sort();
    expect(forbidden, '大脑进程不该加载 mineflayer / prismarine / minecraft-data 之类的客户端库').toEqual([]);
  });

  it('身体进程的闭包里一个大文件都没有，也不加载宿主/模型 SDK', () => {
    const closure = importClosure('src/body/index.ts');
    expect(closure.has('src/body/index.ts')).toBe(true);
    expect(inDir(closure, 'src/brain')).toEqual([]);
    const forbidden = [...bareImports(closure)].filter((spec) => HOST_ONLY.test(spec)).sort();
    expect(forbidden, '身体进程不该加载 MindServer 客户端、express 或模型 SDK').toEqual([]);
  });

  it('宿主（main.ts / MindServer）的闭包里也没有身体文件', () => {
    // 宿主是第三个进程（管 UI 与派生大脑）。它不拉身体——身体是**大脑**拉的。
    const closure = importClosure('main.ts');
    expect(inDir(closure, 'src/body')).toEqual([]);
    // 宿主自己会用 `minecraft-protocol` 去查服务器版本、用 `minecraft-assets`
    // 取贴图，这是 UI 的活，与"身体实现"无关——这里只声明事实，不禁止。
  });

  it('两侧的闭包只共享 src/shared/**（根 settings.ts / main.ts 不算共享）', () => {
    const brain = importClosure('src/brain/index.ts');
    const body = importClosure('src/body/index.ts');
    const shared = [...brain].filter((file) => body.has(file)).sort();
    expect(shared.length).toBeGreaterThan(0);
    for (const file of shared) {
      expect(file.startsWith('src/shared/'), `${file} 同时被两侧加载，但它不在 src/shared/`).toBe(true);
    }
  });

  it('身体与大脑都不许读宿主的那份根配置（读 shared/settings.ts 单例）', () => {
    // 根 settings.ts 是**主进程**的配置字面量。身体进程拿到的是大脑转交的那份，
    // 写在 shared/settings.ts 单例里。读错那一份的后果是"配置看起来配了却不生效"：
    // 身体里的 `settings.cheat` 曾经永远是 false（`/setblock`、瞬间放置全是死代码）。
    const offenders: string[] = [];
    for (const dir of ['src/body', 'src/brain']) {
      for (const file of tsFiles(abs(dir))) {
        for (const target of relativeImports(file)) {
          if (target === 'settings.ts' || target === 'main.ts') offenders.push(`${file} -> ${target}`);
        }
      }
    }
    expect(offenders, '根 settings.ts / main.ts 属于宿主进程，两侧都该读 src/shared/').toEqual([]);
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

  it('仓库里没有别的代码去解析 / 读另一侧的入口', () => {
    // 只认**代码里的路径解析**（`new URL('…', import.meta.url)`），不认注释里
    // 提到入口文件名的散文。允许的两处就是进程边界本身：拉身体的 launcher、
    // 以及拉大脑的 agent_process。
    const allowed = new Set(['src/brain/process/body_launcher.ts', 'src/brain/process/agent_process.ts']);
    const resolution = /new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    const offenders: string[] = [];
    for (const file of [...tsFiles(abs('src')), ...tsFiles(abs('scripts'))]) {
      if (allowed.has(file)) continue;
      const source = readFileSync(abs(file), 'utf8');
      let match: RegExpExecArray | null;
      resolution.lastIndex = 0;
      while ((match = resolution.exec(source)) !== null) {
        const target = match[1] as string;
        if (target.includes('/body/') || target.includes('/brain/')) {
          offenders.push(`${file} -> new URL('${target}')`);
        }
      }
    }
    expect(offenders, '跨进程只能靠 spawn 那条 URL，别的文件不许解析对方入口').toEqual([]);
  });

  it('仓库内没有靠裸包名自引用的 import（那会绕过相对路径检查）', () => {
    // package.json 里没有 `imports`/`exports` 自引用表，也没有 tsconfig paths；
    // 万一有人加上，闭包检查就会漏。这里钉住：裸说明符一律指向 node_modules。
    const offenders: string[] = [];
    for (const file of tsFiles(abs('src'))) {
      let match: RegExpExecArray | null;
      const source = readFileSync(abs(file), 'utf8');
      IMPORT_RE.lastIndex = 0;
      while ((match = IMPORT_RE.exec(source)) !== null) {
        const spec = match[2] as string;
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        if (spec.startsWith('src/') || spec === 'mindcraft' || spec.startsWith('mindcraft/')) {
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
