/*
 * 工具调用的**执行体**：把一次具名参数的工具调用落成命令实现。
 *
 * 这是身体侧唯一的分发点（`MineflayerBody.handle({op:'action'})` 调它）。
 * 大脑那边只发 `{name, args}`——它不知道这个命令是怎么实现的。
 */

import { findCommand } from './registry.js';

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
    // 校验器把 `null` 当"没给"（canOmit 收 null），但 JS 的默认参数只对
    // `undefined` 生效——不在这里归一，`{quantity: null}` 就会把 null 原样
    // 传给 `perform(agent, targetItem, quantity = 1)`，拿不到默认值。
    const ordered = paramNames.map((k) => args[k] ?? undefined);
    try {
        const result: unknown = await command.perform(agent, ...ordered);
        return (result as string | null | undefined) ?? '';
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // **保命打断不是工具故障，别把内部异常甩给模型。** 保命程序会改寻路目标
        // 把身体带离危险，于是正在跑的动作收到 `GoalChanged`——以前这个异常连着
        // 堆栈原样进了回执（"!!Action threw exception!! ... at Object.fleeTo"），
        // 模型既看不懂也不会处理。它是**预期行为**：先处理危险，安全了再继续。
        if (/GoalChanged|path was changed|interrupted by the player/i.test(msg)) {
            return (
                `${toolName} 被保命程序打断了（它检测到危险，正在把身体带离现场），本次动作中止。` +
                `这不是故障，也不用原样重试——先确认危险解除（看事件和快照），再决定继续还是换路。`
            );
        }
        return `Tool ${toolName} failed: ${msg}`;
    }
}
