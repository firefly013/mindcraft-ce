/**
 * 大脑侧的 `Body` 实现：把接口调用翻译成协议请求。
 *
 * 这一层薄到几乎没有逻辑——**故意的**。任何"聪明"的判断放进来都会变成
 * 第二个真相来源：身体已经知道的事，大脑不该再猜一遍。
 *
 * 唯一的例外是 `image()` 和 `hello()` 的**降级**：连不上 / 超时 / 身体不认
 * 这个 op，都不该让整轮推理崩掉。视觉和握手都是锦上添花，
 * 拿不到就安静退化成"没有"，这一点与主线 `safeImage` 的取舍一致。
 */
import { BrainClient, type CloseInfo } from '../shared/protocol/transport.js';
import { DEFAULT_TIMEOUT_MS } from '../shared/protocol/transport.js';
import type {
    ActionRequest,
    ActionResult,
    BodyCapabilities,
    BodyEvent,
    BodyPush,
    BodyResponse,
    ChatPush,
} from '../shared/protocol/types.js';
import { ERR } from '../shared/protocol/types.js';
import type { Body } from '../shared/body.js';

function fail(op: string, response: BodyResponse): never {
    const error = response.ok ? 'unexpected' : response.error;
    throw new Error(`body ${op} failed: ${error}`);
}

export class RemoteBody implements Body {
    private client: BrainClient;
    private handlers: ((event: BodyEvent) => void)[] = [];
    private chatHandlers: ((chat: ChatPush) => void)[] = [];

    private constructor(client: BrainClient) {
        this.client = client;
        client.onPush((push: BodyPush) => {
            if (push.push === 'event') {
                for (const handler of this.handlers) handler(push.event);
            } else if (push.push === 'chat') {
                for (const handler of this.chatHandlers) handler(push.chat);
            }
        });
    }

    static async connect(url: string): Promise<RemoteBody> {
        const client = await BrainClient.connect(url);
        return new RemoteBody(client);
    }

    /**
     * 连身体，**带重试**。
     *
     * 为什么必须重试：身体的协议端口是在它**连上游戏并 spawn 之后**才开的
     * （`src/body/index.ts` 的顺序是"先出生再开门"）。而大脑启动得快得多，直接连
     * 只会扑空。这不是异常，是两个进程正常的启动时序差。
     *
     * 超时给 120 秒：主线 `spawn_timeout` 默认 30 秒，加上启动/资源加载，
     * 留够一倍余量。**真超时就是身体起不来**——那时候报错比静默挂着好。
     */
    static async connectWithRetry(
        url: string,
        timeoutMs = 120_000,
        intervalMs = 500,
        abortIf?: () => Error | null,
    ): Promise<RemoteBody> {
        const deadline = Date.now() + timeoutMs;
        let lastError: unknown = null;
        while (Date.now() < deadline) {
            // "继续等下去已经没意义了"——例如身体进程已经退出，
            // 那它永远不会来开门，剩下的等待只是把错误信息引向错误的方向。
            const fatal = abortIf?.() ?? null;
            if (fatal != null) throw fatal;
            try {
                const client = await BrainClient.connect(url);
                return new RemoteBody(client);
            } catch (err: unknown) {
                lastError = err;
                await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
            }
        }
        throw new Error(
            `body did not come up within ${timeoutMs}ms (${lastError instanceof Error ? lastError.message : String(lastError)})`,
        );
    }

    /** 握手：拿到身体的能力表。这张表决定工具 schema（见 `Agent.bootstrap`）。 */
    async hello(): Promise<BodyCapabilities> {
        const response = await this.client.request({ op: 'hello' });
        if (!response.ok) fail('hello', response);
        if (response.op !== 'hello') throw new Error('body answered the wrong op');
        return response.capabilities;
    }

    async sample(): Promise<unknown> {
        const response = await this.client.request({ op: 'sample' });
        if (!response.ok) fail('sample', response);
        if (response.op !== 'sample') throw new Error('body answered the wrong op');
        return response.state;
    }

    async image(): Promise<string | null> {
        const response = await this.client.request({ op: 'image' }, 30_000);
        if (!response.ok || response.op !== 'image') return null;
        return response.data;
    }

    /**
     * 动作的超时：**不给**。
     *
     * 沿用主线 `runAsAction(timeout = -1)` 的语义——动作由模型自己用 `Stop`
     * 或保命反射终止，不由传输层超时。跨进程超时会把"还在挖"误报成失败，
     * 那正是上一轮修掉的薛定谔状态。
     */
    async act(request: ActionRequest): Promise<ActionResult> {
        const response = await this.client.request({ op: 'action', request }, null);
        if (!response.ok) {
            return { ok: false, text: response.error, code: response.code };
        }
        if (response.op !== 'action') throw new Error('body answered the wrong op');
        return response.result;
    }

    async say(text: string, to?: string): Promise<void> {
        const response = await this.client.request({ op: 'say', text, ...(to != null ? { to } : {}) });
        if (!response.ok) fail('say', response);
    }

    async stop(): Promise<void> {
        const response = await this.client.request({ op: 'stop' }, 20_000);
        if (!response.ok) fail('stop', response);
    }

    async rescue(): Promise<{ triggered: boolean; text: string }> {
        const response = await this.client.request({ op: 'rescue' }, DEFAULT_TIMEOUT_MS);
        if (!response.ok || response.op !== 'rescue') {
            return { triggered: false, text: '' };
        }
        return { triggered: response.triggered, text: response.text };
    }

    async fullState(): Promise<unknown> {
        const response = await this.client.request({ op: 'fullState' });
        if (!response.ok || response.op !== 'fullState') return null;
        return response.state;
    }

    async setGoal(goal: string | null): Promise<void> {
        // 同步失败不抛：目标同步是"锦上添花"，边沿检测器拿不到就按没有目标判。
        await this.client.request({ op: 'setGoal', goal }, 20_000);
    }

    async inventorySlots(): Promise<({ name: string; count: number } | null)[]> {
        const response = await this.client.request({ op: 'inventory.slots' }, 20_000);
        if (!response.ok || response.op !== 'inventory.slots') return [];
        return response.slots;
    }

    async consumeCall(): Promise<{ permitSpent: boolean; guardSpent: boolean }> {
        const response = await this.client.request({ op: 'consumeCall' }, 20_000);
        if (!response.ok || response.op !== 'consumeCall') return { permitSpent: false, guardSpent: false };
        return { permitSpent: response.permitSpent, guardSpent: response.guardSpent };
    }

    async pickupTarget(radius: number): Promise<{ id: number; name: string; x: number; y: number; z: number; distance: number } | null> {
        const response = await this.client.request({ op: 'pickupTarget', radius }, 20_000);
        if (!response.ok || response.op !== 'pickupTarget') return null;
        return response.target;
    }

    /**
     * 走过去的超时**给但不致命**：正常由 `stopMovement` 或身体自己走完来结束。
     * 给 3 分钟是兜底——一个真的卡住的寻路不该让大脑永久挂住（那正是
     * "终端说失败、机器人还在走"的另一面）。
     */
    async walkTo(x: number, y: number, z: number, closeness: number): Promise<boolean> {
        const response = await this.client.request({ op: 'walkTo', x, y, z, closeness }, 3 * 60 * 1000);
        if (!response.ok || response.op !== 'walkTo') return false;
        return response.arrived;
    }

    async stopMovement(): Promise<void> {
        await this.client.request({ op: 'stopMovement' }, 20_000);
    }

    async players(): Promise<string[]> {
        const response = await this.client.request({ op: 'players' }, 20_000);
        if (!response.ok || response.op !== 'players') return [];
        return response.names;
    }

    async position(): Promise<{ x: number; y: number; z: number } | null> {
        const response = await this.client.request({ op: 'position' }, 20_000);
        if (!response.ok || response.op !== 'position') return null;
        return { x: response.x, y: response.y, z: response.z };
    }

    onClose(handler: (info: CloseInfo) => void): void {
        this.client.onClose(handler);
    }

    onEvent(handler: (event: BodyEvent) => void): () => void {
        this.handlers.push(handler);
        return () => {
            const index = this.handlers.indexOf(handler);
            if (index >= 0) this.handlers.splice(index, 1);
        };
    }

    onChat(handler: (chat: ChatPush) => void): () => void {
        this.chatHandlers.push(handler);
        return () => {
            const index = this.chatHandlers.indexOf(handler);
            if (index >= 0) this.chatHandlers.splice(index, 1);
        };
    }

    close(): Promise<void> {
        this.client.close();
        return Promise.resolve();
    }

    /** 诊断用：协议错误码是否说明"这条路根本不通"。 */
    static isTransportDown(code: string): boolean {
        return code === ERR.DISCONNECTED || code === ERR.TIMEOUT;
    }
}
