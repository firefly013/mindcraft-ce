import type { Settings } from './src/shared/types/common.js';

const settings: Settings = {
    "minecraft_version": "auto", // or specific version like "1.21.11"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    // 端口不写在这里。启动时用 --mc-port 指定，不指定就扫描 host 上的局域网端口。
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup

    "profiles": [
        // 不内置默认 Bot。启动时用 --profiles 指定，或在这里加入自己的 profile。
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "用中文回复hello world和你的名字", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "chat_ingame": true, // bot responses are shown in minecraft chat

    "allow_vision": true, // 每轮现拍示意图进 Live State 主循环（粗略重绘，大概看布局）
    "blocked_actions" : [], // tools to disable（按命令名，例如 "!searchWiki"）
    "cheat": false, // allow server-cheat shortcuts (/tp, /setblock, instant place) in skills. Requires OP.

    // 上下文不再有条数上限：唯一的裁剪机制是上下文压缩，触发线是
    // profile 的 context_window - reserve_tokens（见 src/agent/compaction.ts）。

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
};

export default settings;
