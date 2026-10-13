/**
 * 大脑进程入口。
 *
 * 它是**两个进程里的后端**：连 MindServer（对 UI 而言它就是那个 agent）、
 * 连身体（拿世界、动身体）、跑 pi-durable 会话与模型。
 *
 * 它是**唯一**对 MindServer 注册身份的进程——身体不碰 MindServer。
 * 这一点决定了 `world settings` 的来源：settings 由 MindServer 下发，
 * 所以大脑拿到之后再转交给身体（见 `AgentProcess`）。
 */
import { Agent } from './agent.js';
import { serverProxy } from './mindserver_proxy.js';
import yargs from 'yargs';

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_brain.js -n <agent_name> -p <mindserver_port> -b <body_port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', { alias: 'n', type: 'string', description: 'name of agent' })
    .option('load_memory', { alias: 'l', type: 'boolean', description: 'load agent memory from file on startup' })
    .option('init_message', { alias: 'm', type: 'string', description: 'automatically prompt the agent on startup' })
    .option('count_id', { alias: 'c', type: 'number', default: 0, description: 'identifying count for multi-agent scenarios' })
    .option('port', { alias: 'p', type: 'number', description: 'port of mindserver' })
    .option('body_port', { alias: 'b', type: 'number', description: 'port of the body protocol server' })
    .parseSync(); // 同步解析：与原 .argv 行为一致，避免 argv 的 Promise 联合类型

await (async () => {
    try {
        const agentName = argv.name;
        const mindserverPort = argv.port;
        // 同 init_body：`--body-port` 会被 yargs 规范化成 `bodyPort`，两个都认。
        const bodyPort = argv.body_port ?? (argv as unknown as { bodyPort?: number }).bodyPort;
        if (!agentName || mindserverPort === undefined || bodyPort === undefined) {
            console.error('Missing required arguments: -n <agent_name> -p <mindserver_port> -b <body_port>');
            process.exit(1);
        }
        console.log('Connecting to MindServer');
        await serverProxy.connect(agentName, mindserverPort);
        console.log('Starting agent');
        const agent = new Agent();
        agent.setBodyPort(bodyPort);
        serverProxy.setAgent(agent);
        await agent.start(argv.load_memory, argv.init_message ?? null, argv.count_id);
    } catch (error: unknown) {
        console.error('Failed to start agent process:');
        if (error instanceof Error) {
            console.error(error.message);
            console.error(error.stack);
        } else {
            console.error(String(error));
        }
        process.exit(1);
    }
})();
