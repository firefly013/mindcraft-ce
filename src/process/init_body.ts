/**
 * 身体进程入口。
 *
 * 它是**两个进程里的前端**：拉起 Mineflayer，把观察推给大脑，把大脑要的
 * 动作做完。它不知道模型、提示词、计划的存在。
 *
 * 启动顺序（不能换）：先拿 settings（来自环境变量，由主进程转交），
 * 再连游戏，最后才开协议端口——**先开端口再连游戏**会让大脑在身体还没出生时
 * 就来握手，那些请求全部落空。
 */
import yargs from 'yargs';
import { setSettings } from '../agent/settings.js';
import type { Settings } from '../types/common.js';
import { MineflayerBody } from '../body/mineflayer_body.js';
import { BodyServer } from '../protocol/transport.js';
import type { BodyPush } from '../protocol/types.js';

const argv = yargs(process.argv.slice(2))
    .option('name', { alias: 'n', type: 'string', description: 'name of agent' })
    .option('count_id', { alias: 'c', type: 'number', default: 0, description: 'identifying count for multi-agent scenarios' })
    .option('body_port', { type: 'number', description: 'port to serve the body protocol on' })
    .option('settings', { alias: 's', type: 'string', description: 'settings JSON (转交给 Settings 单例)' })
    .parseSync();

await (async () => {
    const agentName = argv.name;
    // yargs 默认会把 `--body-port` 规范成 `bodyPort`（camel-case-expansion），
    // 而 `.option('body_port')` 给的是蛇形键。两个都认，免得被这层命名规则咬到。
    const bodyPort = argv.body_port ?? (argv as unknown as { bodyPort?: number }).bodyPort;
    if (!agentName || bodyPort === undefined) {
        console.error('Missing required arguments: -n <agent_name> --body-port <port>');
        process.exit(1);
    }

    // settings 由主进程算好（它已经做过 `getServer()` 解析 host/port/version），
    // 这里**不再连 MindServer**：身体不需要知道 UI 的存在，
    // 而且多一个 socket 只会让 MindServer 的在线状态多一个真相来源。
    const raw = argv.settings ?? process.env.MINDCRAFT_BODY_SETTINGS;
    if (raw) {
        try {
            setSettings(JSON.parse(raw) as Settings);
        } catch (err: unknown) {
            console.error('body: bad settings JSON:', err instanceof Error ? err.message : String(err));
            process.exit(1);
        }
    } else {
        console.error('body: no settings provided (--settings / MINDCRAFT_BODY_SETTINGS)');
        process.exit(1);
    }

    let server: BodyServer | null = null;
    const body = new MineflayerBody({
        name: agentName,
        countId: argv.count_id,
        sink: (push: BodyPush) => {
            // 身体出生前可能已经有事件（比如登录失败）——那时 server 还是 null。
            server?.push(push);
        },
    });

    const shutdown = (): void => {
        void server?.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await body.start();
    } catch (err: unknown) {
        console.error('body: failed to start:', err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    server = new BodyServer(bodyPort, (request) => body.handle(request));
    console.log(`body for ${agentName} listening on ${bodyPort}`);
})();
