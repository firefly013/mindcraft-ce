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

import type { ToolDeclaration } from '../tools.js';

/** 身体的种类。Java 真客户端接进来时这里是 `java-client`。 */
export type BodyKind = 'mineflayer' | 'java-client' | 'mock';

/** 握手时身体声明的能力。大脑据此决定发出哪些工具。 */
export interface BodyCapabilities {
    bodyKind: BodyKind;
    /** 身体名（= profile.name）。 */
    agentName: string;
    /**
     * 身体能提供的**工具声明**（名字不带前导 `!`）。
     *
     * 工具的**真源在身体**：实现（`perform`）在那边，声明也由那边产出。
     * 大脑只认这份数据——它据此生成 schema、校验参数、判断哪些工具占身体通道。
     * 因此大脑进程里不再需要 import 身体的命令表（那会把整份 mineflayer
     * 代码拖进大脑进程）。身体不支持的命令自然不在这里，无需再求交。
     */
    tools: ToolDeclaration[];
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
 * 身体主动推的事件。字段与 `brain/runtime/events.ts` 的 `GameEvent` 对齐。
 *
 * `level` 是**数字**（`shared/events.ts` 的 `Level`）——它决定了大脑用什么
 * 力度把模型叫来看一眼（write / steer / abort / 锁通道）。用字符串会在两侧
 * 各写一份映射表，那种东西迟早会不一致。
 *
 * **等级是事件的属性，不是处理的属性**：这条事件由谁来处理（身体侧的反射、
 * 大脑侧的反射、还是模型）由 `type` 决定，不由等级决定。
 *
 * `text` 是身体按 `renderEventText` 渲染好的文本，大脑不再重渲一遍。
 */
export interface BodyEvent {
    /** 事件类型（处理的匹配键），如 `world.water.drowning`。两侧逐字一致。 */
    type: string;
    level: number;
    /**
     * 渲染好的事件文本（给模型看的）。
     *
     * **这是优化，不是真源。** 真源是下面的 `{type, level, payload}` 三元组——
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
     * 事件的类别（`shared/events.ts` 的 `Kind`）。**冗余但必要**：`text` 已经是
     * 渲染好的成品，而大脑的审计台账 `loopLog` 记的是**结构化的**
     * `{type, kind, level, payload}`（`Feedback` 工具的历史摘要直接 JSON 化它）。
     * 只在 `text` 里塞类别名，台账就只能记一句人话，模型拿不到结构。
     */
    kind: string;
    /** 原始载荷，同上。 */
    payload: unknown;
    /**
     * **身体为这条事件启动了哪个反射处理**（没有就是 null/缺省）。
     *
     * 身体是唯一知道"我为这条事件做了什么"的地方，所以由它声明；大脑据此
     * 锁动作通道，并在收到对应 `completes` 时解锁。没有它 = 这条事件没人在
     * 身体侧处理，走模型。
     */
    reflex?: string | null;
    /**
     * 这条事件是哪个反射处理的**完成报告**（配对 `reflex`）。
     *
     * 处理结果就是这样进上下文的：处理不是隐式副作用，它留下一条记录。
     */
    completes?: string | null;
}

/**
 * 大脑 → 身体 的请求（全部有应答）。
 *
 * 用可辨识联合而不是一堆方法，是为了让**传输层只认一种信封**：加一个操作
 * 就是加一个 `op`，不用动 transport。
 *
 * **能力尽量走工具（`action`）**：这里只留"工具装不下"的东西——握手、观测
 * （快照/画面）、说话、停机，以及 MindServer UI 要的整份状态。曾经的
 * `walkTo` / `stopMovement` / `pickupTarget` / `inventory.slots` / `setGoal` /
 * `consumeCall` / `rescue` / `players` / `position` 全是把某个大脑侧策略需要的
 * 身体能力开了个专用后门，现在它们各自回到了本该在的位置：**移动是工具，
 * 掉落物与背包变化是事件，保命与拾取是身体的反射，额度由身体自己扣，
 * 在线玩家与坐标在世界快照里**。
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
    | { op: 'sample' }
    | { op: 'image' }
    | { op: 'action'; request: ActionRequest }
    /** 说话。`to` 给了就是私聊（对那个人 whisper）。 */
    | { op: 'say'; text: string; to?: string }
    /** 停掉身体上正在跑的一切（Stop / 死亡 / 抢占时用）。 */
    | { op: 'stop' }
    /** MindServer UI 用的整份状态。 */
    | { op: 'fullState' }
    | { op: 'shutdown' };

/** 身体 → 大脑 的应答。 */
export type BodyResponse =
    | { ok: true; op: 'hello'; capabilities: BodyCapabilities }
    /** 世界快照。`LiveState` 是纯数据，渲染留在大脑侧（渲染是纯函数）。 */
    | { ok: true; op: 'sample'; state: unknown }
    /** 现拍画面（base64 jpeg）。拍不到给 null，大脑侧安静降级成纯文本。 */
    | { ok: true; op: 'image'; data: string | null }
    | { ok: true; op: 'action'; result: ActionResult }
    | { ok: true; op: 'say' }
    | { ok: true; op: 'stop' }
    | { ok: true; op: 'fullState'; state: unknown }
    | { ok: true; op: 'shutdown' }
    | { ok: false; op: string; error: string; code: string };

/**
 * 一条聊天：它是**事件**（`player.chat`）的载荷，不是第二条通道。
 *
 * `from` / `message` / `whisper` 是身体能如实报告的全部；"这是玩家在问我、
 * 还是队友在报坐标"依赖**大脑侧**的知识（谁是队友来自 profiles），
 * 所以那是这条事件的**处理**，不是它自己该带的信息。
 *
 * 以前它单列一条 `push: 'chat'` 通道，理由是"区分不能丢"——但那个区分一直
 * 都是大脑做的，通道并列只是让"一切皆事件"出现了一个例外。
 */
export interface ChatMessage {
    from: string;
    message: string;
    whisper: boolean;
}

/** 身体 → 大脑 的推送（无应答）。**只有事件一条通道**。 */
export type BodyPush = { push: 'event'; event: BodyEvent };

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
