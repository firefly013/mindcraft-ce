/**
 * 前后端协议：消息形状的唯一真源。
 *
 * 前端 = 身体（Mineflayer，将来是 Java 真客户端）；后端 = 大脑（VLM）。
 * 这里是两者之间**唯一**允许的东西，两侧都不许直接碰对方的内部对象。
 *
 * 设计原则（三条，改动前先读）：
 *
 * 1. **不是 RPC，是 env 接口。** 大脑只做两件事：要一份 observation、发一个 action。
 *    身体除此之外还会**主动推 event**——挨打、掉血、动作完成都不是大脑能轮询出来的。
 * 2. **回执同时给人看和给机器看。** `text` 是给模型看的回执（与主线逐字一致），
 *    `code` / `data` 是给程序用的。只搬 `text` 等于没分层。
 * 3. **动作是长生命周期的。** 每条 `action` 有 id、可取消；"身体正被占用"是身体自己的
 *    状态，大脑不能假设同步返回。
 */

/** 身体的种类。Java 真客户端接进来时这里是 `java-client`。 */
export type BodyKind = 'mineflayer' | 'java-client' | 'mock';

/** 握手时身体声明的能力。大脑据此决定发出哪些工具。 */
export interface BodyCapabilities {
    bodyKind: BodyKind;
    /** 身体名（= profile.name）。 */
    agentName: string;
    /**
     * 身体支持的命令名（已去掉前导 `!`）。
     *
     * 大脑拿它跟 `GAME_COMMANDS` 求交——身体不支持的命令**不进工具 schema**，
     * 否则模型会调一个必然失败的工具。
     */
    commands: string[];
    /** 身体能提供的观测。现在只有世界快照和画面两种。 */
    observations: string[];
}

/** 一次动作调用。 */
export interface ActionRequest {
    /** 命令名，**不带**前导 `!`。 */
    name: string;
    /** 具名参数。形状对回 `executeToolCall(agent, name, args)`。 */
    args: Record<string, unknown>;
}

/** 动作回执。 */
export interface ActionResult {
    /** 是否成功。失败时 `text` 是可直接给模型看的错误说明。 */
    ok: boolean;
    /** 给模型看的回执文本。与主线 `executeToolCall` 的返回值逐字一致。 */
    text: string;
    /** 机器可读原因码。成功为 `'OK'`。 */
    code: string;
    /** 结构化数据（可选）。目前命令实现只产文本，先留位。 */
    data?: unknown;
}

/**
 * 身体主动推的事件。字段与 `runtime/events.ts` 的 `GameEvent` 对齐。
 *
 * `level` 是**数字**（`scheduler.ts` 的 `Level`）——它决定了大脑用什么原语
 * 处理这条事件（write / steer / preempt / emergency）。用字符串会在两侧各写
 * 一份映射表，那种东西迟早会不一致。
 * `text` 是身体按主线 `renderEventText` 渲染好的文本，大脑不再重渲一遍。
 */
export interface BodyEvent {
    level: number;
    /**
     * 渲染好的事件文本（给模型看的）。
     *
     * **这是优化，不是真源。** 真源是下面的 `{kind, level, payload}` 三元组——
     * 谁渲染取决于谁有那个渲染器：Mineflayer 身体能 import `renderEventText`
     * （同一份 TS 代码），所以它渲染；**Java 身体渲染不了**（那是 TS 函数），
     * 它发空串，由**大脑**渲染。
     *
     * 这条不是为了将来，是 Java 身体马上要用：两种身体共用一个协议，
     * 就必须让"谁渲染"可协商。见 DECISIONS D-59。
     */
    text: string;
    /** 事件发生的时间戳（毫秒）。 */
    ts: number;
    /**
     * 事件的类别（`scheduler.KIND`）。**冗余但必要**：`text` 已经是渲染好的
     * 成品，而大脑的审计台账 `loopLog` 记的是**结构化的** `{kind, level, payload}`
     * （`Feedback` 工具的历史摘要直接 JSON 化它）。只在 `text` 里塞类别名，
     * 台账就只能记一句人话，模型拿不到结构。
     */
    kind: string;
    /** 原始载荷，同上。 */
    payload: unknown;
}

/**
 * 大脑 → 身体 的请求（全部有应答）。
 *
 * 用可辨识联合而不是一堆方法，是为了让**传输层只认一种信封**：加一个操作
 * 就是加一个 `op`，不用动 transport。
 */
export type BrainRequest =
    /**
     * 握手。身体把能力表报上来。
     *
     * **不带协议版本号**（原来带过，删了，见 DECISIONS D-55）：这个项目里两个人
     * 都没有——大脑和身体是同一个人同一个仓库同一次提交编出来的，两侧永远一致，
     * 那个检查在结构上不可能触发。等 Java 身体变成一个**单独编译、可能陈旧**的
     * 产物时再加，那时它才是真的在防一件事，而且加回来就是十几行。
     */
    | { op: 'hello' }
    | { op: 'ping' }
    | { op: 'sample' }
    | { op: 'image' }
    | { op: 'action'; request: ActionRequest }
    /** 说话。`to` 给了就是私聊（对那个人 whisper）。 */
    | { op: 'say'; text: string; to?: string }
    /** 停掉身体上正在跑的一切（Stop / 死亡 / 抢占时用）。 */
    | { op: 'stop' }
    /** 保命反射。身体侧跑，不等大脑一轮。 */
    | { op: 'rescue' }
    /** MindServer UI 用的整份状态。 */
    | { op: 'fullState' }
    /**
     * 同步当前目标给身体。
     *
     * 目标属于决策层（`PlanStore` 在大脑），但**边沿检测器要用它**：
     * `snapshotFromBot(bot, {goal})` 里 goal 参与"这件事跟目标有关系吗"
     * 的判断。所以大脑在目标变化时单向同步一次，身体只读不写、不解释。
     */
    | { op: 'setGoal'; goal: string | null }
    /**
     * 扣一次"按次数"额度（危险操作授权 / 保命抑制）。
     *
     * **必须在身体侧扣**：这两份状态是**模块级单例**，而授权是命令实现
     * （`commands/actions.ts`，跑在身体里）发的，读取点是 `skills.ts`
     * （也在身体里）。大脑那边也有一份自己的拷贝——在那边扣等于没扣，
     * 后果是**次数制授权与保命关闭永不过期**（次数制的 `expiresAt` 是 null）。
     */
    | { op: 'consumeCall' }
    /**
     * 半径内最近的掉落物。**这是能力，不是策略**：身体只回答"附近有什么东西"，
     * "要不要去捡"由大脑决定（自动拾取是为 VLM 做的外层设施）。
     */
    | { op: 'pickupTarget'; radius: number }
    /** 走过去。走完才回（被 `stopMovement` 打断则提前回）。**能力**。 */
    | { op: 'walkTo'; x: number; y: number; z: number; closeness: number }
    /** 停下移动（打断 `walkTo`）。**能力**。 */
    | { op: 'stopMovement' }
    /**
     * 背包原始槽位。只给 `Task`（minecollab 任务）数目标物品用。
     *
     * 不走 `sample` 是因为 `LiveState` 的背包是**给人看**的摘要（预算裁剪过），
     * 而任务判定要的是精确计数。这条是现存的真实需求，不是预留。
     */
    | { op: 'inventory.slots' }
    /**
     * 在线玩家名。只给 `Task` 的 `teleportBots`（minecollab 任务布置）用——
     * 它要把 bot 传送到人类玩家身边，需要知道有谁在线。
     */
    | { op: 'players' }
    /** 当前位置。同上，任务布置用。 */
    | { op: 'position' }
    | { op: 'shutdown' };

/** 身体 → 大脑 的应答。 */
export type BodyResponse =
    | { ok: true; op: 'hello'; capabilities: BodyCapabilities }
    | { ok: true; op: 'ping'; ts: number }
    /** 世界快照。`LiveState` 是纯数据，渲染留在大脑侧（渲染是纯函数）。 */
    | { ok: true; op: 'sample'; state: unknown }
    /** 现拍画面（base64 jpeg）。拍不到给 null，大脑侧安静降级成纯文本。 */
    | { ok: true; op: 'image'; data: string | null }
    | { ok: true; op: 'action'; result: ActionResult }
    | { ok: true; op: 'say' }
    | { ok: true; op: 'stop' }
    | { ok: true; op: 'rescue'; triggered: boolean; text: string }
    | { ok: true; op: 'fullState'; state: unknown }
    | { ok: true; op: 'setGoal' }
    | { ok: true; op: 'consumeCall'; permitSpent: boolean; guardSpent: boolean }
    | { ok: true; op: 'pickupTarget'; target: { id: number; name: string; x: number; y: number; z: number; distance: number } | null }
    | { ok: true; op: 'walkTo'; arrived: boolean }
    | { ok: true; op: 'stopMovement' }
    | { ok: true; op: 'inventory.slots'; slots: ({ name: string; count: number } | null)[] }
    | { ok: true; op: 'players'; names: string[] }
    | { ok: true; op: 'position'; x: number; y: number; z: number }
    | { ok: true; op: 'shutdown' }
    | { ok: false; op: string; error: string; code: string };

/**
 * 聊天单列一类推送，**不混进事件里**。
 *
 * 理由：主线区分了"玩家在跟你说话"和"队友在报坐标"——前者必须投成真正的
 * 用户回合（`runtime.submit`），后者才是事件。这个区分依赖**大脑侧**的知识
 * （谁是队友来自 profiles），所以身体只负责如实转发，由大脑判。
 * 如果把它塞进通用 `event`，这个区分就丢了，主线修过的"他们收到但不理我"
 * 会原样复发。
 */
export interface ChatPush {
    from: string;
    message: string;
    whisper: boolean;
}

/** 身体 → 大脑 的推送（无应答）。 */
export type BodyPush =
    | { push: 'event'; event: BodyEvent }
    | { push: 'chat'; chat: ChatPush };

/** 线上跑的信封。 */
export type Envelope =
    | ({ kind: 'request'; id: number } & BrainRequest)
    | ({ kind: 'response'; id: number } & BodyResponse)
    | ({ kind: 'push' } & BodyPush);

/** 错误码。两边共用，别各写一份字符串。 */
export const ERR = {
    /** 身体不认识这条命令（能力协商没拦住）。 */
    UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
    /** 身体内部抛异常。 */
    BODY_ERROR: 'BODY_ERROR',
    /** 信封形状不对。 */
    BAD_ENVELOPE: 'BAD_ENVELOPE',
    /** 连接断了。 */
    DISCONNECTED: 'DISCONNECTED',
    /** 请求超时。 */
    TIMEOUT: 'TIMEOUT',
} as const;
