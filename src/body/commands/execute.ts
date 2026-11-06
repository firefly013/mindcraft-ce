/*
 * 工具调用的**执行体**：把一次具名参数的工具调用落成命令实现。
 *
 * 这是身体侧唯一的分发点（`MineflayerBody.handle({op:'action'})` 调它）。
 * 大脑那边只发 `{name, args}`——它不知道这个命令是怎么实现的。
 */

import { findCommand } from './registry.js';

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

/** 动作返回后、采样结束位置之前的落定时间（ms）：别把"还在滑行"算成搜索的位移。 */
export const SEARCH_SETTLE_MS = 250;

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "这次搜索有没有真的靠近目标"——**实测**的两个距离之差（起手距目标 → 现在距目标）。
 *
 * 比"移动了几格"有用得多：绕路也可能移动很多格却没靠近（真机 overnight_a 就是被
 * 一个对不上的位移数字弄糊涂的）。拿不到目标坐标或起手位置就说"量不出来"，不猜。
 */
export function closingSummary(
    before: Position | null,
    after: Position | null,
    target: Position | null,
): string {
    if (target == null || before == null || after == null) return '';
    const d0 = Math.hypot(before.x - target.x, before.y - target.y, before.z - target.z);
    const d1 = Math.hypot(after.x - target.x, after.y - target.y, after.z - target.z);
    const delta = d0 - d1;
    const numbers = `距离目标从 ${d0.toFixed(1)} 格变成了 ${d1.toFixed(1)} 格`;
    if (delta >= 0.3) return `${numbers}，靠近了 ${delta.toFixed(1)} 格。`;
    if (delta <= -0.3) return `${numbers}，反而远了 ${Math.abs(delta).toFixed(1)} 格。`;
    return `${numbers}。`;
}

/**
 * 搜索类回执必须回答两个问题：有没有找到、玩家被挪到哪了。
 *
 * 这一段单独抽出来是为了能单测：只有身体侧知道动作前后的真实位置，
 * 大脑侧的 ActionRunner 只能看到一段文本。
 */
export function movementSummary(before: Position | null, after: Position | null): string {
    if (before == null || after == null) return '读不到这次移动了多远。';
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const dz = after.z - before.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.3) return `这次没有移动，你还在 ${formatPosition(after)}。`;
    return `这次移动了 ${distance.toFixed(1)} 格，从 ${formatPosition(before)} 到了 ${formatPosition(after)}。`;
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
    // **允许中间那段"（掉落 xxx）"**：actions.ts 的真实文案是
    // `采集完成：iron_ore（掉落 raw_iron）背包 0 → 6（+6），移动 12 格。`
    // 旧正则要求"类型"后面**立刻**是"背包"，于是一次都没匹配上——真机 2026-10-23
    // 用 CLI 通关时，48 块圆石到手，回执却只会说"无法确认结果"。
    const done = /采集完成：([^\s（]+)(?:（掉落 ([^）]*)）)?\s*背包 (\d+)\s*→\s*(\d+)（\+(\d+)），移动 ([\d.]+) 格/.exec(body);
    // actions.ts 2026-11-06 改成自然中文后的格式（不带冒号/箭头）。
    const naturalDone = /采到了 ([^\s，]+)，掉出 (\d+) 个 ([^，]+)，背包里这些掉落从 (\d+) 个变成 (\d+) 个，一共移动了 ([\d.]+) 格。/.exec(body);
    if (naturalDone != null) {
        return `collectBlocks 采到了 ${naturalDone[1]}，掉出 ${naturalDone[2]} 个 ${naturalDone[3]}，背包里这些掉落从 ${naturalDone[4]} 个变成 ${naturalDone[5]} 个，一共移动了 ${naturalDone[6]} 格。`;
    }
    if (done != null) {
        const dropped = done[2] != null && done[2] !== '' ? `，掉出了 ${done[2]}` : '';
        return `collectBlocks 采到了 ${done[1]}${dropped}，背包里从 ${done[3]} 个变成了 ${done[4]} 个，多出 ${done[5]} 个，这次一共移动了 ${done[6]} 格。`;
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
        const bag = unchanged != null ? `背包里还是 ${unchanged[1]} 个` : '背包里的数量没有变化';
        return `这次没能采到 ${blockName}，因为手上没有能挖它的工具，拿的是 ${held}，${bag}。`;
    }
    // 找不到：自然中文格式（actions.ts 2026-11-06）。
    const naturalUnchanged = /没能采到 ([^\s，]+)，([^，]+)的数量没有变化，一共移动了 ([\d.]+) 格。/.exec(body);
    if (naturalUnchanged != null) {
        return `collectBlocks 没能采到 ${naturalUnchanged[1]}，${naturalUnchanged[2]}的数量没有变化，一共移动了 ${naturalUnchanged[3]} 格。`;
    }
    const unchanged = /采集结束：([^\s（]+)(?:（掉落 [^）]*）)?\s*数量没变(?:（仍是 (\d+)）)?[。，,]?\s*移动 ([\d.]+) 格/.exec(body);
    if (unchanged != null) {
        const still = unchanged[2] != null ? `背包里还是 ${unchanged[2]} 个` : '背包里的数量没有变化';
        return `这次没能采到 ${unchanged[1]}，${still}，一共移动了 ${unchanged[3]} 格。`;
    }
    return `这次没能确认 collectBlocks 采到了什么，因为读不到背包账目。${body === '' ? '' : `原始日志是 ${body.slice(0, 200)}`}`;
}

export function annotateSearchForBlock(
    text: string,
    args: Record<string, unknown>,
    before: Position | null,
    after: Position | null,
): string {
    const type = typeof args['type'] === 'string' ? args['type'] : '未知方块';
    const range = args['search_range'] == null ? '默认' : String(args['search_range']);
    const moved = movementSummary(before, after);
    const body = text.trim();
    const target = parseFoundPosition(body);
    const from = after ?? before;
    const targetText =
        target == null
            ? '坐标读不到'
            : `在 (${target.x}, ${target.y}, ${target.z})`;
    const distanceText =
        target != null && from != null
            ? `，距离你 ${Math.hypot(from.x - target.x, from.y - target.y, from.z - target.z).toFixed(1)} 格`
            : '';
    if (body.includes('Could not find any') || body.includes('范围内确实没有')) {
        return `这次在 ${range} 格范围内没有找到 ${type}，只覆盖了已经加载的区块。${moved}`;
    }
    if (body.includes('could not reach it')) {
        return `找到了 ${type}，它${targetText}${distanceText}，但是走不过去，搜索范围是 ${range} 格。${moved}${closingSummary(before, from, target)}`;
    }
    if (/\bFound\b/i.test(body) && target != null) {
        return `找到了 ${type}，它${targetText}${distanceText}，搜索范围是 ${range} 格。${moved}${closingSummary(before, from, target)}`;
    }
    if (/被中断|中断（|interrupted/i.test(body)) {
        const whoMatch = /这次动作被中断了，(?:打断它的是 ([^。]{1,40})|中断原因没有记录下来)/.exec(body);
        const who = whoMatch?.[1] ?? '';
        return `searchForBlock 这次被中断了，${who === '' ? '打断它的原因没有记录下来' : `打断它的是 ${who}`}，搜索范围是 ${range} 格。${moved}`;
    }
    if (body.includes('超时')) {
        return `searchForBlock 这次超时了，搜索范围是 ${range} 格。${moved}`;
    }
    return `这次没能确认 ${type} 的情况，搜索范围是 ${range} 格。${moved}`;
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
            // **落定再采样**：动作刚返回时身体可能还在滑行/被寻路器最后推一下，
            // 立刻采样会把这段"余量"算进这次搜索的位移里——真机 overnight_a 反馈
            // 「searchForBlock 报告位移与实际不符」，量的时机就是原因之一。
            await sleepMs(SEARCH_SETTLE_MS);
            return annotateSearchForBlock(String(text), args, before, readPosition(agent));
        }
        if (toolName === 'collectBlocks') {
            return annotateCollectBlocks(String(text));
        }
        // **空回执一律给一句交代**（2026-10-23：用 CLI 通关时，goToCoordinates /
        // collectBlocks 有时返回空串，终端上就是一片空白——操作者既不知道成没成，
        // 也不知道该不该重试）。以前这里是一张手写清单，清单漏掉的工具照样沉默；
        // 改成按结果判断：只要没内容就说清楚，不再维护第二份名单。
        if (String(text).trim() === '') {
            const who = String((agent?.bot as any)?.__interruptReason ?? '').trim();
            return who !== '' ? `${toolName} 没有返回内容，是被${who}打断的。` : `${toolName} 没有返回内容。`;
        }
        return text;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // **保命打断不是工具故障，别把内部异常甩给模型。** 保命程序会改寻路目标
        // 把身体带离危险，于是正在跑的动作收到 `GoalChanged`——以前这个异常连着
        // 堆栈原样进了回执（"!!Action threw exception!! ... at Object.fleeTo"），
        // 模型既看不懂也不会处理。它是**预期行为**：先处理危险，安全了再继续。
        if (/GoalChanged|path was changed|interrupted by the player/i.test(msg)) {
            return `${toolName} 这次被保命反射打断了。`;
        }
        return `${toolName} 执行失败了，${msg}`;
    } finally {
        // **每个工具结束都松开方向盘**（真机 2026-10-23 用 CLI 通关时定位的浪费时间大头）：
        // 上一个动作留下的 `sprint`/`forward` 不会自己松，人看到的画面是
        // "站在原地晃、脚下冒冲刺粒子、对着方块连续空挥、还 180 度转身"——
        // 那不是物理算错，是**按键还按着**。控制状态是身体状态，不是动作的一部分，
        // 工具退出时必须兜底清掉；清不掉也要留下痕迹，别让它无声地耗时间。
        try {
            const bot: any = (agent as { bot?: unknown })?.bot;
            if (bot != null && !bot.interrupt_code) {
                for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
                    try {
                        bot.setControlState(key, false);
                    } catch {
                        // 拿不到控制就尽力而为。
                    }
                }
            }
        } catch {
            // 清理失败不影响回执。
        }
    }
}
