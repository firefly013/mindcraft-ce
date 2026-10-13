/**
 * 身体（前端）的契约。
 *
 * 大脑只认这个接口，不认 Mineflayer。今天的实现是 `RemoteBody`（走协议）
 * 和 `MineflayerBody`（跑在身体进程里）；将来 `JavaClientBody` 实现了同一份接口，
 * 大脑一行不用改。
 *
 * 接口的字段是**从现状反推**的，不是设计出来的：`src/body/` 里 506 处 `bot.*`
 * 收敛下来就是下面这些——读状态（sample / image）、发动作（act / say / stop）、
 * 保命（rescue）、事件订阅、连接关闭。
 */
import type { CloseInfo } from './protocol/transport.js';
import type {
    ActionRequest,
    ActionResult,
    BodyCapabilities,
    BodyEvent,
    ChatPush,
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

    /** 保命反射。L5 走的通道，绕过模型。 */
    rescue(): Promise<{ triggered: boolean; text: string }>;

    /** MindServer UI 要的整份状态。 */
    fullState(): Promise<unknown>;

    /**
     * 把当前目标同步给身体。目标属于大脑，但**身体的边沿检测器要用它**
     * （判断"这件事跟目标有关系吗"）。单向、幂等、不解释。
     */
    setGoal(goal: string | null): Promise<void>;

    /** 背包原始槽位。只给 `Task` 数目标物品用（`LiveState` 的背包是给人看的摘要）。 */
    inventorySlots(): Promise<({ name: string; count: number } | null)[]>;

    /**
     * 扣一次"按次数"额度。**这不是大脑的状态**——授权由身体里的命令实现发出，
     * 由身体里的 `skills.ts` 读取。大脑只负责在每次工具调用后通知一声。
     */
    consumeCall(): Promise<{ permitSpent: boolean; guardSpent: boolean }>;

    /** 半径内最近的掉落物；没有就 null。**能力**，不是策略。 */
    pickupTarget(radius: number): Promise<{ id: number; name: string; x: number; y: number; z: number; distance: number } | null>;

    /** 走到某点。走完才 resolve；被 `stopMovement` 打断会提前 resolve `false`。 */
    walkTo(x: number, y: number, z: number, closeness: number): Promise<boolean>;

    /** 停下移动。 */
    stopMovement(): Promise<void>;

    /** 在线玩家名。只给 `Task` 的 `teleportBots` 用。 */
    players(): Promise<string[]>;

    /** 当前位置。同上。 */
    position(): Promise<{ x: number; y: number; z: number } | null>;

    /**
     * 身体这一侧的连接断了。
     *
     * 大脑是**唯一**能发现这件事的地方——身体自己死了，没法通知任何人。
     * 没有这条订阅时，大脑会安安静静地变成僵尸：心跳照跑、模型照调、
     * 每个动作都失败，而日志里一条错都没有（真机实测：身体被杀后两分钟，
     * 大脑日志零新增）。
     */
    onClose(handler: (info: CloseInfo) => void): void;

    /** 订阅身体主动推的事件。返回取消订阅的函数。 */
    onEvent(handler: (event: BodyEvent) => void): () => void;

    /**
     * 订阅聊天。**与事件分开**是有意的：主线区分"玩家在问我"（必须回应，
     * 投成真正的用户回合）和"队友在报坐标"（事件即可），而这个区分依赖
     * 大脑侧的 profile 知识（谁是队友），所以身体只如实转发。
     */
    onChat(handler: (chat: ChatPush) => void): () => void;

    close(): Promise<void>;
}
