#!/usr/bin/env node
/**
 * **续做（resume）外部测试台**：不经过模型，接进游戏、从外部操控，验证
 * "反射抢走身体 → 动作被作废 → 反射完成 → 机械续做"。
 *
 * 背景（用户 2026-10-31）：续做不经过模型，所以没法像以前那样"接进游戏让 VLM
 * 去试"。这里改成像 CLI 那样：**无模型接入**（`profiles/player.json` 没有 model），
 * 用 MindServer 的 `cli-command` 从外部驱动，用服务器控制台/RCON 制造危险。
 *
 * 用法：
 *   node scripts/harness/resume.mjs --agent player
 *   node scripts/harness/resume.mjs --agent player --name collectBlocks \
 *        --args '{"type":"oak_log","num":32}' --trigger 'rcon-cli "summon zombie ~2 ~ ~"'
 *
 * 不带 `--trigger` 时，脚本会在提交后 2.5 秒提示你**手动**去服务器控制台执行
 * `/summon zombie ~2 ~ ~`（或别的危险），然后继续观察。
 *
 * 退出码：0 = 观察到了期望的续做；1 = 超时/没观察到/出错。
 */
import { exec } from 'node:child_process';
import { io } from 'socket.io-client';

function parseArgs(argv) {
    const out = {
        agent: 'player',
        port: Number(process.env.MINDSERVER_PORT ?? 8080),
        name: 'collectBlocks',
        args: { type: 'oak_log', num: 32 },
        trigger: null,
        triggerDelayMs: 2500,
        timeoutMs: 240_000,
        expect: 'resume',
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        const next = argv[i + 1];
        const take = () => {
            i++;
            return next;
        };
        switch (token) {
            case '--agent':
                out.agent = take();
                break;
            case '--port':
                out.port = Number(take()) || out.port;
                break;
            case '--name':
                out.name = take();
                break;
            case '--args':
                try {
                    out.args = JSON.parse(take());
                } catch {
                    console.error('--args 不是合法 JSON');
                    process.exit(2);
                }
                break;
            case '--trigger':
                out.trigger = take();
                break;
            case '--trigger-delay':
                out.triggerDelayMs = Number(take()) || out.triggerDelayMs;
                break;
            case '--timeout':
                out.timeoutMs = Number(take()) || out.timeoutMs;
                break;
            case '--expect':
                out.expect = take() === 'none' ? 'none' : 'resume';
                break;
            case '-h':
            case '--help':
                out.help = true;
                break;
            default:
                console.error(`不认识的参数：${token}`);
                process.exit(2);
        }
    }
    return out;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
    console.log(
        [
            '续做外部测试台（无模型）：',
            '  node scripts/harness/resume.mjs --agent player [选项]',
            '',
            '选项：',
            '  --agent <名字>       手动模式的机器人名（profile 里不能有 model）',
            '  --port <端口>        MindServer 端口（默认 MINDSERVER_PORT / 8080）',
            '  --name <工具名>      要测试的动作（默认 collectBlocks）',
            '  --args <JSON>        动作参数（默认 {"type":"oak_log","num":32}）',
            '  --trigger <命令>     到点后执行的 shell 命令（例如 RCON/服务器控制台脚本）',
            '  --trigger-delay <ms> 提交后多久触发危险（默认 2500）',
            '  --timeout <ms>       总超时（默认 240000）',
            '  --expect resume|none 期望是否观察到续做（默认 resume）',
        ].join('\n'),
    );
    process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = [];
let cursor = 0;
const collect = (events) => {
    const fresh = (events ?? []).filter((e) => e.at > cursor);
    for (const event of fresh) {
        seen.push(event);
        cursor = Math.max(cursor, event.at);
        const label = `L${event.level}/${event.action}`.padEnd(16);
        console.log(`  ${label} ${String(event.text).slice(0, 220)}`);
    }
};

const socket = io(`http://localhost:${opts.port}`, { reconnection: false });
await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`连不上 MindServer（端口 ${opts.port}）`)), 5000);
    socket.on('connect', () => {
        clearTimeout(timer);
        resolve();
    });
    socket.on('connect_error', (err) => {
        clearTimeout(timer);
        reject(new Error(`连不上 MindServer（端口 ${opts.port}）：${String(err)}`));
    });
});

/** 发一条 `cli-command`，等 ack。 */
function send(payload, timeoutMs = 20_000) {
    return new Promise((resolve) => {
        const timer = setTimeout(
            () => resolve({ ok: false, timeout: true, error: 'cli-command 等 ack 超时' }),
            timeoutMs + 5000,
        );
        socket.emit('cli-command', opts.agent, { ...payload, timeoutMs }, (res) => {
            clearTimeout(timer);
            resolve(res ?? { ok: false, error: 'MindServer 回了空结果' });
        });
    });
}

let exitCode;
try {
    console.log(`\n== 续做测试台 ==`);
    console.log(`agent=${opts.agent} port=${opts.port} action=${opts.name} args=${JSON.stringify(opts.args)}`);
    console.log('说明：动作走**大脑的动作通道**（via runner），和模型同一条契约。\n');

    const started = await send({ op: 'start', name: opts.name, args: opts.args, via: 'runner', since: 0 });
    collect(started.events);
    if (!started.ok || started.jobId == null) {
        console.error(`提交失败：${started.error ?? '未知原因'}`);
        throw new Error('start failed');
    }
    const jobId = started.jobId;
    console.log(`\n任务 #${jobId} 已提交（via runner）。`);

    setTimeout(() => {
        if (opts.trigger != null) {
            console.log(`\n[${new Date().toLocaleTimeString()}] 触发危险：${opts.trigger}`);
            exec(opts.trigger, (err, stdout, stderr) => {
                if (err != null) console.error(`触发命令失败：${err.message}\n${stderr ?? ''}`);
                else if (stdout) console.log(String(stdout).trim());
            });
        } else {
            console.log(
                '\n>>> 现在去服务器控制台执行（3 秒内）：/summon zombie ~2 ~ ~\n' +
                    '    （或 /setblock ~ ~-1 ~ lava 测岩浆反射；或 /summon creeper ~3 ~ ~）\n',
            );
        }
    }, opts.triggerDelayMs);

    const startedAt = Date.now();
    let job = null;
    while (Date.now() - startedAt < opts.timeoutMs) {
        await sleep(500);
        const status = await send({ op: 'status', id: jobId, since: cursor });
        collect(status.events);
        if (!status.ok) continue;
        job = status.job ?? null;
        if (job != null && job.state !== 'running') break;
    }

    // 任务回执（"被中断"那条）可能先于「续做」事件到达：再等一会儿，别提前判负。
    const resumeSeen = () => seen.some((e) => String(e.text ?? '').includes('已替你续做'));
    const resumeDeadline = Date.now() + 10_000;
    while (opts.expect === 'resume' && !resumeSeen() && Date.now() < resumeDeadline) {
        await sleep(300);
        const status = await send({ op: 'status', id: jobId, since: cursor });
        collect(status.events);
    }

    // 补一次事件（最后 500ms 内可能还有）。
    const final = await send({ op: 'status', id: jobId, since: cursor });
    collect(final.events);

    const textOf = (e) => String(e.text ?? '');
    const sawL5 = seen.some((e) => Number(e.level) >= 5);
    const sawInterruptReceipt = seen.some((e) => textOf(e).includes('自动续做') || textOf(e).includes('被中断'));
    const sawResume = seen.some((e) => textOf(e).includes('已替你续做') || textOf(e).includes('action.resumed'));
    const jobDone = job != null && job.state === 'done';

    console.log('\n== 结果 ==');
    console.log(`  任务状态：${job?.state ?? 'unknown'}（${job != null ? Math.round((job.ms ?? 0) / 1000) : 0}s）`);
    console.log(`  L5 反射事件：${sawL5 ? '有' : '没有'}`);
    console.log(`  中断回执：${sawInterruptReceipt ? '有' : '没有'}`);
    console.log(`  续做事件：${sawResume ? '有' : '没有'}`);
    if (job?.output != null) console.log(`  任务回执：${String(job.output).slice(0, 500)}`);
    if (job?.error != null) console.log(`  任务错误：${job.error}`);

    const summary = { jobId, jobState: job?.state ?? 'unknown', sawL5, sawInterruptReceipt, sawResume, events: seen.length };
    console.log(`\nSUMMARY ${JSON.stringify(summary)}`);

    if (opts.expect === 'resume') {
        exitCode = jobDone && sawResume ? 0 : 1;
        if (exitCode !== 0) {
            console.error(
                '没观察到续做。排查顺序：① bot 是手动模式（profile 无 model）吗？② 动作真的跑起来了吗' +
                    '（job 回执/日志）？③ 危险真的触发了 L5 吗（看上面事件流）？④ 动作的 resume 声明是 auto/checkpoint 吗？',
            );
        }
    } else {
        exitCode = jobDone && !sawResume ? 0 : 1;
    }
} catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    exitCode = 1;
} finally {
    socket.close();
    process.exitCode = exitCode ?? 1;
}
