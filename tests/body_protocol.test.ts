/**
 * 协议层：握手与"动作不能被超时咬掉"。
 *
 * **走真的 WebSocket**（`BodyServer` 监听端口 0 拿临时端口），不是打桩。
 * 理由：这两条恰好是打桩测不出来的那类——它们全是真机才现形的东西
 * （D-10 的 `Infinity` 假超时：打桩里没有 `setTimeout` 的真实行为），
 * 打桩只会把我的假设再抄一遍。
 *
 * 这里原来还有两条"协议版本不匹配应当拒绝"的测试，随那个机制一起删了
 * （DECISIONS D-55）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteBody } from '../src/body/remote_body.js';
import { BodyServer } from '../src/protocol/transport.js';
import {
    ERR,
    type BodyCapabilities,
    type BodyResponse,
    type BrainRequest,
} from '../src/protocol/types.js';

const CAPS: BodyCapabilities = {
    bodyKind: 'mineflayer',
    agentName: 'tester',
    commands: ['stats', 'moveTo'],
    observations: ['live-state'],
};

const servers: BodyServer[] = [];

/** 起一个身体，返回它的 ws 地址。 */
function serve(handler: (req: BrainRequest) => Promise<BodyResponse> | BodyResponse): string {
    const server = new BodyServer(0, async (req) => await handler(req));
    servers.push(server);
    return `ws://127.0.0.1:${server.port}`;
}

/** 一个"标准身体"：回能力表、动作延迟指定毫秒。 */
function standardBody(options: { actionDelayMs?: number; caps?: Partial<BodyCapabilities> } = {}) {
    return serve((req): BodyResponse | Promise<BodyResponse> => {
        switch (req.op) {
            case 'hello':
                return { ok: true, op: 'hello', capabilities: { ...CAPS, ...options.caps } };
            case 'action': {
                const delay = options.actionDelayMs ?? 0;
                const answer: BodyResponse = {
                    ok: true,
                    op: 'action',
                    result: { ok: true, text: 'done', code: 'OK' },
                };
                if (delay === 0) return answer;
                return new Promise<BodyResponse>((resolve) => {
                    setTimeout(() => resolve(answer), delay);
                });
            }
            default:
                return { ok: false, op: 'unknown', error: `no ${req.op}`, code: ERR.UNKNOWN_COMMAND };
        }
    });
}

afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
});

describe('握手', () => {
    it('把身体的能力表原样带回来', async () => {
        const body = await RemoteBody.connect(standardBody());
        const caps = await body.hello();
        expect(caps.bodyKind).toBe('mineflayer');
        expect(caps.commands).toEqual(['stats', 'moveTo']);
        expect(caps.observations).toEqual(['live-state']);
        body.close();
    });
});

describe('动作通道', () => {
    it('**慢动作不会被超时咬掉**（D-10 的回归测试）', async () => {
        // 旧实现拿 `Number.POSITIVE_INFINITY` 当"不超时"，而
        // `setTimeout(fn, Infinity)` 在 Node 里等于 1ms → 每个动作在发出的一瞬间
        // 就"超时"，回执是假的而格式完全正常。这个测试慢 1.2 秒，但它是唯一
        // 能拦住那次事故的东西——当时单测/类型/lint 全绿。
        const body = await RemoteBody.connect(standardBody({ actionDelayMs: 1200 }));
        const result = await body.act({ name: 'stats', args: {} });
        expect(result.ok).toBe(true);
        expect(result.text).toBe('done');
        body.close();
    });
});

describe('身体失联', () => {
    /** 关掉最后一个起好的身体，并从 afterEach 的清理列表里摘掉。 */
    async function closeLastServer(): Promise<void> {
        const server = servers.pop();
        if (server != null) await server.close();
    }

    it('身体断开时大脑能收到关闭通知（这是"身体没了"唯一能被发现的地方）', async () => {
        const body = await RemoteBody.connect(standardBody());
        const seen: Array<{ code: number; reason: string }> = [];
        body.onClose((info) => seen.push(info));

        await closeLastServer();
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(seen).toHaveLength(1);
        expect(typeof seen[0].code).toBe('number');
        body.close();
    });

    it('身体进程已经崩了 → 立刻失败，不白等满 120 秒（D-57）', async () => {
        // 写 Java 身体时"崩在开门前"是常态。没有这个钩子，报出来的错会是
        // "body did not come up within 120000ms"，把方向指到超时上去。
        const started = Date.now();
        const dead = new Error('body process exited before opening its port (code 1, signal null)');
        await expect(
            RemoteBody.connectWithRetry('ws://127.0.0.1:1', 120_000, 50, () => dead),
        ).rejects.toThrow(/exited before opening its port/);
        expect(Date.now() - started).toBeLessThan(2000);
    });
});
