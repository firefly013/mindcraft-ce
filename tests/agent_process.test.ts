import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AgentProcess,
    MAX_QUICK_RESTARTS,
    QUICK_EXIT_WINDOW_MS,
    quickRestartBackoffMs,
} from '../src/brain/process/agent_process.js';

vi.mock('../src/brain/mindserver/mindserver.js', () => ({
    logoutAgent: vi.fn(),
}));

class FakeChild extends EventEmitter {
    killed = false;

    kill(signal?: string): boolean {
        this.killed = true;
        this.emit('exit', null, signal ?? 'SIGINT');
        return true;
    }
}

interface Harness {
    agent: AgentProcess;
    children: FakeChild[];
    logs: string[];
    warns: string[];
    errors: string[];
    exitCodes: number[];
    spawnCalls: () => number;
}

function makeHarness(): Harness {
    const children: FakeChild[] = [];
    const logs: string[] = [];
    const warns: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const spawn = vi.fn(() => {
        const child = new FakeChild();
        children.push(child);
        return child as unknown as ChildProcess;
    });
    const agent = new AgentProcess('overnight_a', 8080, {
        spawn,
        exit: (code) => { exitCodes.push(code); },
        log: (message) => { logs.push(message); },
        warn: (message) => { warns.push(message); },
        error: (message) => {
            errors.push(typeof message === 'string' ? message : message.message);
        },
    });
    return { agent, children, logs, warns, errors, exitCodes, spawnCalls: () => spawn.mock.calls.length };
}

describe('AgentProcess 启动自愈', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('快速崩溃按指数退避重启，日志写清第几次和退避多久', () => {
        const h = makeHarness();
        h.agent.start(false, null, 0);
        expect(h.spawnCalls()).toBe(1);

        h.children[0]!.emit('exit', 1, null);
        expect(h.spawnCalls()).toBe(1);
        expect(h.warns.join('\n')).toContain('quick crash 1/' + MAX_QUICK_RESTARTS);
        expect(h.warns.join('\n')).toContain('Restart #1 scheduled in 1000ms');

        vi.advanceTimersByTime(1000);
        expect(h.spawnCalls()).toBe(2);

        h.children[1]!.emit('exit', 1, null);
        expect(h.warns.join('\n')).toContain('Restart #2 scheduled in 2000ms');
        vi.advanceTimersByTime(2000);
        expect(h.spawnCalls()).toBe(3);
    });

    it('快速崩溃达到上限后停止自动重启', () => {
        const h = makeHarness();
        h.agent.start(false, null, 0);

        for (let attempt = 1; attempt <= MAX_QUICK_RESTARTS; attempt += 1) {
            h.children[attempt - 1]!.emit('exit', 1, null);
            vi.advanceTimersByTime(quickRestartBackoffMs(attempt));
        }
        expect(h.spawnCalls()).toBe(1 + MAX_QUICK_RESTARTS);

        h.children[MAX_QUICK_RESTARTS]!.emit('exit', 1, null);
        vi.advanceTimersByTime(10 * 60 * 1000);
        expect(h.spawnCalls()).toBe(1 + MAX_QUICK_RESTARTS);
        expect(h.errors.join('\n')).toContain('limit of ' + MAX_QUICK_RESTARTS);
        expect(h.errors.join('\n')).toContain('will not restart again');
    });

    it('稳定运行超过窗口后立即重启，并清零快速崩溃计数', () => {
        const h = makeHarness();
        h.agent.start(false, null, 0);

        vi.advanceTimersByTime(QUICK_EXIT_WINDOW_MS + 1);
        h.children[0]!.emit('exit', 1, null);
        expect(h.spawnCalls()).toBe(2);
        expect(h.logs.join('\n')).toContain('restart #1 starting immediately');

        h.children[1]!.emit('exit', 1, null);
        expect(h.warns.join('\n')).toContain('quick crash 1/' + MAX_QUICK_RESTARTS);
        expect(h.warns.join('\n')).toContain('Restart #2 scheduled in 1000ms');
        vi.advanceTimersByTime(1000);
        expect(h.spawnCalls()).toBe(3);
    });

    it('code > 1 保留结束任务语义：退出整个进程且不重启', () => {
        const h = makeHarness();
        h.agent.start(false, null, 0);
        h.children[0]!.emit('exit', 2, null);
        expect(h.exitCodes).toEqual([2]);
        expect(h.spawnCalls()).toBe(1);
        expect(h.logs.join('\n')).toContain('ended the task with exit code 2');
    });

    it('code 0 正常退出不重启', () => {
        const h = makeHarness();
        h.agent.start(false, null, 0);
        h.children[0]!.emit('exit', 0, null);
        vi.advanceTimersByTime(60_000);
        expect(h.spawnCalls()).toBe(1);
    });

    it('stop() 会取消等待中的退避重启', () => {
        const h = makeHarness();
        h.agent.start(false, null, 0);
        h.children[0]!.emit('exit', 1, null);
        expect(h.warns.join('\n')).toContain('scheduled in 1000ms');

        h.agent.stop();
        expect(h.logs.join('\n')).toContain('Cancelled pending restart');
        vi.advanceTimersByTime(60_000);
        expect(h.spawnCalls()).toBe(1);
    });

    it('退避序列第 1-5 次是 1/2/4/8/16 秒，之后封顶 30 秒', () => {
        expect([1, 2, 3, 4, 5, 6].map(quickRestartBackoffMs)).toEqual([
            1000, 2000, 4000, 8000, 16000, 30000,
        ]);
    });
});
