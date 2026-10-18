/*
 * 工具调用的**执行体**：把一次具名参数的工具调用落成命令实现。
 *
 * 这是身体侧唯一的分发点（`MineflayerBody.handle({op:'action'})` 调它）。
 * 大脑那边只发 `{name, args}`——它不知道这个命令是怎么实现的。
 */

import { findCommand } from './registry.js';

/** 需要「有头有尾」的动作类工具：身体返回空串也必须给模型一句交代。 */
const ACTION_TOOLS_NEEDING_RECEIPT = new Set([
    'useBlock',
    'useEntity',
    'craft',
    'searchForBlock',
    'collectBlocks',
    'digDown',
    'mineBlock',
    'placeBlock',
    'placeHere',
    'goToCoordinates',
    'goToPlayer',
    'moveAway',
    'equip',
    'consume',
    'attack',
    'useOn',
]);

interface Position {
    x: number;
    y: number;
    z: number;
}

function readPosition(agent: any): Position | null {
    const pos = agent?.bot?.entity?.position;
    if (pos == null) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { x, y, z };
}

function formatPosition(pos: Position | null): string {
    if (pos == null) return '位置读不到';
    return `(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`;
}

/**
 * 搜索类回执必须回答两个问题：有没有找到、玩家被挪到哪了。
 *
 * 这一段单独抽出来是为了能单测：只有身体侧知道动作前后的真实位置，
 * 大脑侧的 ActionRunner 只能看到一段文本。
 */
export function movementSummary(before: Position | null, after: Position | null): string {
    if (before == null || after == null) return '搜索期间玩家位置读不到（以 stats 的 Position 为准）。';
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const dz = after.z - before.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.3) return `搜索期间玩家没有移动（仍在 ${formatPosition(after)}）。`;
    return `搜索期间玩家移动了 ${distance.toFixed(1)} 格：${formatPosition(before)} → ${formatPosition(after)}。`;
}

/** 从身体日志里解析目标方块坐标（支持 `at (x, y, z)` 和 `x:.. y:.. z:..` 两种形状）。 */
export function parseFoundPosition(text: string): Position | null {
    const paren = /at\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/i.exec(text);
    if (paren != null) {
        const x = Number(paren[1]);
        const y = Number(paren[2]);
        const z = Number(paren[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return { x, y, z };
    }
    const labeled = /x:\s*(-?[\d.]+)[,;]?\s*y:\s*(-?[\d.]+)[,;]?\s*z:\s*(-?[\d.]+)/i.exec(text);
    if (labeled != null) {
        const x = Number(labeled[1]);
        const y = Number(labeled[2]);
        const z = Number(labeled[3]);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return { x, y, z };
    }
    return null;
}

/**
 * collectBlocks 回执统一按背包 before→after 收口。
 *
 * 真机矛盾：前半句技能日志写 "Collected 1 iron_ore."，后半句按背包对账写
 * "数量没变（仍是 0）"。模型无法判断到底挖没挖到。这里只信背包账目，
 * 把技能日志降级为辅助信息。
 */
export function annotateCollectBlocks(text: string): string {
    const body = text.trim();
    const done = /采集完成：([^\s]+) 背包 (\d+)\s*→\s*(\d+)（\+(\d+)），移动 ([\d.]+) 格/.exec(body);
    if (done != null) {
        return (
            `collectBlocks：已采集到 ${done[1]}（背包 ${done[2]} → ${done[3]}，+${done[4]}）；` +
            `移动 ${done[5]} 格。`
        );
    }
    // **缺工具是独立原因**：技能层已经写了"没有能挖 X 的工具（手持 Y）"，
    // 不能再把它归到"掉落被抢/不可达"里。Feedback #36：同一次失败里
    // mineBlock 的报错说清了缺镐，collectBlocks 却只报"数量没变"，
    // 模型于是去查掉落物和寻路，真正缺的那把镐反而没人提。
    const noTool = /没有能挖 ([^\s（]+) 的工具（手持 ([^）]*)）/.exec(body);
    if (noTool != null) {
        const blockName = noTool[1];
        const held = noTool[2];
        const unchanged = /数量没变（仍是 (\d+)）/.exec(body);
        const bag = unchanged != null ? `背包 ${unchanged[1]} → ${unchanged[1]}，没变化` : '背包没有增加';
        return (
            `collectBlocks：**没有能挖 ${blockName} 的工具（手持 ${held}）**，所以一块都没采到（${bag}）。` +
            '这不是掉落被抢、也不是目标太远：缺的就是对应的工具（镐/铲/斧）。' +
            '先 equip 正确的工具（或去箱子里拿一把）；只求挖开软方块（下界岩/泥土/沙/沙砾）可以用 mineBlock 徒手挖，' +
            '但**没有工具就不会有掉落**。请用 stats 核对背包。'
        );
    }
    const unchanged = /采集结束：([^\s]+) 数量没变（仍是 (\d+)）。移动 ([\d.]+) 格/.exec(body);
    if (unchanged != null) {
        return (
            `collectBlocks：没有采集到 ${unchanged[1]}（背包 ${unchanged[2]} → ${unchanged[2]}，没变化）。` +
              '技能内部日志可能写过 Collected，但以背包账目为准：掉落可能还在附近、被 autoPickup 抢走，或目标不可达。' +
            `移动 ${unchanged[3]} 格。请用 stats 再核对背包，不要重复挖。`
        );
    }
    return (
        'collectBlocks：无法从背包 before→after 确认结果（日志里没有可解析的背包账目）。' +
        '请用 stats 核对背包，不要仅凭技能内部日志判定成功。' +
        (body === '' ? '' : ' 原始日志：' + body.slice(0, 200))
    );
}

export function annotateSearchForBlock(
    text: string,
    args: Record<string, unknown>,
    before: Position | null,
    after: Position | null,
): string {
    const type = typeof args['type'] === 'string' ? args['type'] : '(未知方块)';
    const range = args['search_range'] == null ? '默认' : String(args['search_range']);
    const moved = movementSummary(before, after);
    const body = text.trim();
    const target = parseFoundPosition(body);
    const from = after ?? before;
    const targetText =
        target == null
            ? '坐标没能从身体日志里解析出来'
            : `@(${target.x},${target.y},${target.z})`;
    const distanceText =
        target != null && from != null
            ? `，离你约 ${Math.hypot(from.x - target.x, from.y - target.y, from.z - target.z).toFixed(1)} 格`
            : '';
    // **每条回执都要以"结论"收尾。** 模型连续两次收到"没有得到明确结论"，
    // 却不知道是没搜到、被中断、还是日志丢了，于是只能原样重试
    // （Feedback #42：缩小范围再试，回执一模一样）。这里分四类收口：
    // 找到 / 找到但走不到 / 明确没有 / 拿不到结论（**附原因**）。
    if (body.includes('Could not find any') || body.includes('范围内确实没有')) {
        return (
            `searchForBlock：未找到 ${type}（搜索范围 ${range} 格，已搜完；**只覆盖已加载区块，约等于视距**，` +
            `范围外的区块没加载就看不到）。${moved}结论：已加载范围内没有 ${type}；` +
            '要么换个位置/方向再搜，要么先走过去把区块加载出来。'
        );
    }
    if (body.includes('could not reach it')) {
        return (
            `searchForBlock：找到了 ${type} ${targetText}，但走不过去（路径被堵或太远）。` +
            `搜索范围 ${range} 格${distanceText}；${moved}` +
            `结论：范围内找到了 ${type} ${targetText}，但当前走不到；要么挖通道/绕路过去，要么换目标。`
        );
    }
    if (/\bFound\b/i.test(body) && target != null) {
        return (
            `searchForBlock：找到了 ${type} ${targetText}${distanceText}（搜索范围 ${range} 格）。` +
            `${moved}结论：范围内找到了 ${type} ${targetText}。`
        );
    }
    if (/被中断|中断（|interrupted/i.test(body)) {
        return (
            `searchForBlock：搜索没做完就被中断了（Stop / 保命反射 / autoPickup 抢走身体都会这样），` +
            `搜索范围 ${range} 格；${moved}` +
            `结论：无法确认 ${type} 是否在范围内（原因：搜索被中断，没有写出找到/未找到）。` +
            '通道已释放，可以缩小 search_range 重试或换目标；急用就先 stats 核对当前位置。' +
            (body === '' ? '' : ` 原始日志：${body.slice(0, 160)}`)
        );
    }
    if (body.includes('超时')) {
        return (
            `searchForBlock：搜索超时（跑满时限被停掉），搜索范围 ${range} 格；${moved}` +
            `结论：无法确认 ${type} 是否在范围内（原因：搜索超时中断）。` +
            '可以缩小 search_range 再试，或先走到可疑区域附近。'
        );
    }
    if (body === '' || body === '(no output)' || body.includes('Searching for')) {
        const why = body === '' || body === '(no output)'
            ? '身体日志是空的（动作被中断时输出会被丢弃，或日志读取失败）'
            : '日志只写到"开始搜索"，没有写出找到/未找到';
        return (
            `searchForBlock：没有得到明确结论，不能确认是否找到 ${type}（可能还在搜、被中断（Stop/autoPickup），` +
            '或客户端/日志没有同步）。' +
            `搜索范围 ${range} 格；${moved}` +
            `结论：无法确认 ${type} 是否在范围内（原因：${why}）。` +
            '请用 stats 看当前位置，必要时缩小 search_range 重试。'
        );
    }
    return (
        `searchForBlock：没有得到明确结论，不能确认是否找到 ${type}。搜索范围 ${range} 格；${moved}` +
        `结论：无法确认 ${type} 是否在范围内（原因：身体日志里没有出现明确的找到/未找到结论）。` +
        '请用 stats 核对当前位置，必要时缩小 search_range 重试。'
    );
}

/**
 * 执行一次原生工具调用，底层复用同一个 command.perform。
 * args 为对象，按 command.params 的 key 顺序展开为位置参数。
 */
export async function executeToolCall(agent: any, toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    if (toolName === 'Finish') return 'Finished.';
    const command = findCommand(toolName);
    if (!command) {
        return `Unknown tool: ${toolName}.`;
    }
    const paramNames = command.params ? Object.keys(command.params) : [];
    // 校验器把 `null` 当没给（canOmit 收 null），但 JS 的默认参数只对
    // `undefined` 生效——不在这里归一，`{quantity: null}` 就会把 null 原样
    // 传给 `perform(agent, targetItem, quantity = 1)`，拿不到默认值。
    const ordered = paramNames.map((k) => args[k] ?? undefined);
    const before = toolName === 'searchForBlock' ? readPosition(agent) : null;
    try {
        const result: unknown = await command.perform(agent, ...ordered);
        const text = (result as string | null | undefined) ?? '';
        if (toolName === 'searchForBlock') {
            return annotateSearchForBlock(String(text), args, before, readPosition(agent));
        }
        if (toolName === 'collectBlocks') {
            return annotateCollectBlocks(String(text));
        }
        if (String(text).trim() === '' && ACTION_TOOLS_NEEDING_RECEIPT.has(toolName)) {
            return (
                `${toolName} 执行结束，但身体没有返回具体结果（可能被中断，或被 autoPickup 抢走了身体）。` +
                '请用 stats 核对当前位置和背包，再决定是否重试。'
            );
        }
        return text;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // **保命打断不是工具故障，别把内部异常甩给模型。** 保命程序会改寻路目标
        // 把身体带离危险，于是正在跑的动作收到 `GoalChanged`——以前这个异常连着
        // 堆栈原样进了回执（"!!Action threw exception!! ... at Object.fleeTo"），
        // 模型既看不懂也不会处理。它是**预期行为**：先处理危险，安全了再继续。
        if (/GoalChanged|path was changed|interrupted by the player/i.test(msg)) {
            return (
                `${toolName} 被保命程序打断了（它检测到危险，正在把身体带离现场），本次动作中止。` +
                '这不是故障，也不用原样重试——先确认危险解除（看事件和快照），再决定继续还是换路。'
            );
        }
        return `Tool ${toolName} failed: ${msg}`;
    }
}
