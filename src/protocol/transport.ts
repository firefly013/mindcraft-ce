/**
 * 传输层：JSON over WebSocket。
 *
 * 选型理由：跨语言（将来 Java 侧要接），
 * 所以不能是 Node 专有的 IPC；protobuf/gRPC 在 Java 模组侧要 shade 依赖，太重。
 * WebSocket + JSON 是两边都能零成本实现的交集。
 *
 * 这一层**只搬信封**，不认识任何业务字段——认业务的是 `body.ts` 和大脑侧。
 * 好处是加一个操作只改 `types.ts`，这里一行不动。
 */
import { WebSocketServer, WebSocket } from 'ws';
import {
    ERR,
    type BodyPush,
    type BodyResponse,
    type BrainRequest,
    type Envelope,
} from './types.js';

/** 默认请求超时。动作可以跑几分钟，所以默认给得宽，由调用方按需收紧。 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function badEnvelope(error: string): BodyResponse {
    return { ok: false, op: 'unknown', error, code: ERR.BAD_ENVELOPE };
}

function errorResponse(op: string, err: unknown): BodyResponse {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, op, error: message, code: ERR.BODY_ERROR };
}

/**
 * 身体侧：监听端口，应答大脑的请求，并主动推事件。
 *
 * 只接受**一个**大脑连接——一个身体对应一个大脑，第二个连进来是配置错误，
 * 不是要支持的场景。
 */
export class BodyServer {
    private wss: WebSocketServer;
    private socket: WebSocket | null = null;
    private handler: (req: BrainRequest) => Promise<BodyResponse>;

    constructor(port: number, handler: (req: BrainRequest) => Promise<BodyResponse>) {
        this.handler = handler;
        this.wss = new WebSocketServer({ port });
        this.wss.on('connection', (socket: WebSocket) => {
            if (this.socket !== null) {
                socket.close(1013, 'a body serves exactly one brain');
                return;
            }
            this.socket = socket;
            socket.on('message', (raw: Buffer) => {
                void this.onMessage(socket, raw);
            });
            socket.on('close', () => {
                if (this.socket === socket) this.socket = null;
            });
            socket.on('error', () => {
                if (this.socket === socket) this.socket = null;
            });
        });
    }

    private async onMessage(socket: WebSocket, raw: Buffer): Promise<void> {
        let envelope: Envelope;
        try {
            envelope = JSON.parse(raw.toString('utf8')) as Envelope;
        } catch {
            socket.send(JSON.stringify({ kind: 'response', id: -1, ...badEnvelope('JSON parse failed') }));
            return;
        }
        if (envelope.kind !== 'request') return;
        const { id, ...request } = envelope;
        try {
            const response = await this.handler(request as BrainRequest);
            socket.send(JSON.stringify({ kind: 'response', id, ...response }));
        } catch (err: unknown) {
            socket.send(JSON.stringify({ kind: 'response', id, ...errorResponse(request.op, err) }));
        }
    }

    /** 主动推一条消息给大脑（事件、日志）。连接不在就丢弃——事件不是账本。 */
    push(push: BodyPush): void {
        if (this.socket == null || this.socket.readyState !== WebSocket.OPEN) return;
        this.socket.send(JSON.stringify({ kind: 'push', ...push }));
    }

    get port(): number {
        const address = this.wss.address();
        return typeof address === 'object' && address !== null ? address.port : 0;
    }

    close(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.socket?.close();
            this.wss.close(() => resolve());
        });
    }
}

/** 连接关闭的信息。`code` 是 WebSocket 关闭码，`reason` 是对方给的原因（可能为空串）。 */
export interface CloseInfo {
    code: number;
    reason: string;
}

/**
 * 大脑侧：连身体，发请求，收推送。
 *
 * 请求是**串行**的吗？不是——动作只有一个（身体通道保证），但 `sample` /
 * `image` / `positions` 这些轻量调用要能跟长动作并行，否则模型在动作跑着的时候
 * 连"我血还剩多少"都问不到。所以这里不排队，各自带 id 等自己的应答。
 */
export class BrainClient {
    private socket: WebSocket;
    private nextId = 1;
    private pending = new Map<
        number,
        { resolve: (r: BodyResponse) => void; timer: ReturnType<typeof setTimeout> | null }
    >();
    private pushHandlers: ((p: BodyPush) => void)[] = [];
    private closeHandlers: ((info: CloseInfo) => void)[] = [];

    private constructor(socket: WebSocket) {
        this.socket = socket;
        socket.on('message', (raw: Buffer) => {
            this.onMessage(raw);
        });
        // 关闭要能被上层看见：这一层只搬信封，但"信封没了"是上层的决策依据。
        socket.on('close', (code: number, reason: Buffer) => {
            for (const handler of this.closeHandlers) handler({ code, reason: reason.toString('utf8') });
        });
    }

    static async connect(url: string): Promise<BrainClient> {
        const socket = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', (err: Error) => reject(err));
        });
        return new BrainClient(socket);
    }

    private onMessage(raw: Buffer): void {
        let envelope: Envelope;
        try {
            envelope = JSON.parse(raw.toString('utf8')) as Envelope;
        } catch {
            return;
        }
        if (envelope.kind === 'push') {
            const { kind: _kind, ...push } = envelope;
            for (const handler of this.pushHandlers) handler(push as BodyPush);
            return;
        }
        if (envelope.kind !== 'response') return;
        const { id, ...response } = envelope;
        const entry = this.pending.get(id);
        if (entry == null) return;
        if (entry.timer !== null) clearTimeout(entry.timer);
        this.pending.delete(id);
        entry.resolve(response as BodyResponse);
    }

    /**
     * 发一条请求等应答。
     *
     * `timeoutMs = null` 表示**永远不等超时**——动作类请求必须这样（见 D-10）。
     * 别用 `Infinity` 表达这个意思：`setTimeout(fn, Infinity)` 在 Node 里会被
     * 当成 1ms，于是每一个动作都在发出的一瞬间"超时"。这是真机实测抓到的
     * 第一个 bug（`request timed out after Infinityms`）。
     */
    request(req: BrainRequest, timeoutMs: number | null = DEFAULT_TIMEOUT_MS): Promise<BodyResponse> {
        const id = this.nextId++;
        return new Promise<BodyResponse>((resolve) => {
            const timer =
                timeoutMs === null
                    ? null
                    : setTimeout(() => {
                          this.pending.delete(id);
                          resolve({
                              ok: false,
                              op: req.op,
                              error: `request timed out after ${timeoutMs}ms`,
                              code: ERR.TIMEOUT,
                          });
                      }, timeoutMs);
            this.pending.set(id, { resolve, timer });
            if (this.socket.readyState !== WebSocket.OPEN) {
                if (timer !== null) clearTimeout(timer);
                this.pending.delete(id);
                resolve({ ok: false, op: req.op, error: 'body disconnected', code: ERR.DISCONNECTED });
                return;
            }
            this.socket.send(JSON.stringify({ kind: 'request', id, ...req }));
        });
    }

    onPush(handler: (p: BodyPush) => void): void {
        this.pushHandlers.push(handler);
    }

    /**
     * 订阅连接关闭。
     *
     * **这是"身体没了"唯一能被发现的地方**：身体自己是死了，没法通知任何人；
     * 请求失败（`DISCONNECTED`）是被动的、只有刚好有人调用时才知道。
     */
    onClose(handler: (info: CloseInfo) => void): void {
        this.closeHandlers.push(handler);
    }

    close(): void {
        this.socket.close();
    }
}
