import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import yargs from 'yargs';

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent',
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup',
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup',
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver',
    })
    .parseSync(); // 同步解析：与原 .argv 行为一致，避免 argv 的 Promise 联合类型

await (async () => {
    try {
        const agentName = argv.name;
        const mindserverPort = argv.port;
        if (!agentName || mindserverPort === undefined) {
            console.error('Missing required arguments: -n <agent_name> -p <port>');
            process.exit(1);
        }
        console.log('Connecting to MindServer');
        await serverProxy.connect(agentName, mindserverPort);
        console.log('Starting agent');
        const agent = new Agent();
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
