/**
 * scripts/evolve.mjs 的守护进程契约测试。
 *
 * 用真脚本 + 假入口跑，不启动 main.ts、不连游戏。假入口自己写计数文件，
 * 这样能证明「重启真的发生了几次」，而不是只看日志。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'evolve-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir == null) continue;
        await rm(dir, { recursive: true, force: true });
    }
});

interface SupervisorRun {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** 真脚本 + 假入口：环境变量指定入口，脚本因此跳过 tsx 与 main.ts。 */
function runSupervisor(entry: string, env: Record<string, string>): Promise<SupervisorRun> {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(process.execPath, ['scripts/evolve.mjs'], {
            cwd: REPO_ROOT,
            env: { ...process.env, MINDCRAFT_EVOLVE_ENTRY: entry, ...env },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });
        child.on('error', rejectRun);
        child.on('close', (code) => {
            resolveRun({ code, stdout, stderr });
        });
    });
}

async function writeEntry(dir: string, body: string): Promise<string> {
    const file = join(dir, 'entry.mjs');
    await writeFile(file, body, 'utf8');
    return file;
}

describe('evolve 守护进程', () => {
    it('退出码 75 时重启一次，第二次正常退出', async () => {
        const dir = await tempDir();
        const counter = join(dir, 'counter.txt');
        // 第一次运行把计数写成 1 再要重启，第二次写成 2 后正常结束。
        const entry = await writeEntry(
            dir,
            [
                "import { readFileSync, writeFileSync } from 'node:fs';",
                'const file = process.env.EVOLVE_TEST_COUNTER;',
                'let count = 0;',
                "try { count = Number(readFileSync(file, 'utf8')); } catch { count = 0; }",
                'count += 1;',
                'writeFileSync(file, String(count));',
                'if (count === 1) { process.exit(75); }',
                'process.exit(0);',
            ].join('\n'),
        );

        const result = await runSupervisor(entry, { EVOLVE_TEST_COUNTER: counter });

        expect(result.code).toBe(0);
        expect((await readFile(counter, 'utf8')).trim()).toBe('2');
        expect(result.stdout).toContain('重启');
    }, 20000);

    it('其他退出码不重启，守护进程跟着退出', async () => {
        const dir = await tempDir();
        const counter = join(dir, 'counter.txt');
        const entry = await writeEntry(
            dir,
            [
                "import { readFileSync, writeFileSync } from 'node:fs';",
                'const file = process.env.EVOLVE_TEST_COUNTER;',
                'let count = 0;',
                "try { count = Number(readFileSync(file, 'utf8')); } catch { count = 0; }",
                'writeFileSync(file, String(count + 1));',
                'process.exit(1);',
            ].join('\n'),
        );

        const result = await runSupervisor(entry, { EVOLVE_TEST_COUNTER: counter });

        expect(result.code).toBe(1);
        expect((await readFile(counter, 'utf8')).trim()).toBe('1');
    }, 20000);

    it('连续快速重启到上限就放弃，不再拉起', async () => {
        const dir = await tempDir();
        const counter = join(dir, 'counter.txt');
        // 每次都让应用在 10 秒窗口里以 75 退出。脚本允许 5 次快速重启，
        // 第 6 次请求重启时放弃并退出 1，所以假入口总共被拉起 6 次。
        const entry = await writeEntry(
            dir,
            [
                "import { readFileSync, writeFileSync } from 'node:fs';",
                'const file = process.env.EVOLVE_TEST_COUNTER;',
                'let count = 0;',
                "try { count = Number(readFileSync(file, 'utf8')); } catch { count = 0; }",
                'writeFileSync(file, String(count + 1));',
                'process.exit(75);',
            ].join('\n'),
        );

        const result = await runSupervisor(entry, { EVOLVE_TEST_COUNTER: counter });

        expect(result.code).toBe(1);
        expect((await readFile(counter, 'utf8')).trim()).toBe('6');
        expect(result.stderr).toContain('放弃重启');
    }, 30000);
});
