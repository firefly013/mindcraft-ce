/**
 * 身体（前端）的契约。
 *
 * 大脑只认这个接口，不认 Mineflayer。今天的实现是 `RemoteBody`（走协议）
 * 和 `MineflayerBody`（跑在身体进程里）；将来 `JavaClientBody` 实现了同一份接口，
 * 大脑一行不用改。
 *
 * 接口的字段是**从现状反推**的，不是设计出来的：`src/body/` 里 506 处 `bot.*`
 * 收敛下来就是下面这些——读状态（sample / image）、发动作（act / say / stop）、
 * 整份状态（UI 用）、事件订阅、连接关闭。
 */
import type { CloseInfo } from './protocol/transport.js';
import type {
    ActionRequest,
    ActionResult,
    BodyCapabilities,
    BodyEvent,
} from './protocol/types.js';

export interface Body {
    /** 握手。大脑据此决定发哪些工具。 */
    hello(): Promise<BodyCapabilities>;

    /**
     * 采一次世界快照。返回 `LiveState`（纯数据）——**渲染留在大脑侧**，
     * 因为 `renderLiveState` 是纯函数，这样提示词文本与主线逐字一致。
     */
    sample(): Promise<unknown>;

    /** 现拍一张画面（base64 jpeg）。拍不到返回 null，大脑安静降级。 */
    image(): Promise<string | null>;

    /** 跑一条命令。长动作会一直挂着，直到做完或被 `stop`。 */
    act(request: ActionRequest): Promise<ActionResult>;

    /** 说话。`to` 给了就是私聊。 */
    say(text: string, to?: string): Promise<void>;

    /** 停掉身体上正在跑的一切。 */
    stop(): Promise<void>;

    /** MindServer UI 要的整份状态。 */
    fullState(): Promise<unknown>;

    /**
     * 身体这一侧的连接断了。
     *
     * 大脑是**唯一**能发现这件事的地方——身体自己死了，没法通知任何人。
     * 没有这条订阅时，大脑会安安静静地变成僵尸：心跳照跑、模型照调、
     * 每个动作都失败，而日志里一条错都没有（真机实测：身体被杀后两分钟，
     * 大脑日志零新增）。
     */
    onClose(handler: (info: CloseInfo) => void): void;

    /** 订阅身体主动推的事件（聊天也是事件）。返回取消订阅的函数。 */
    onEvent(handler: (event: BodyEvent) => void): () => void;

    close(): Promise<void>;
}
