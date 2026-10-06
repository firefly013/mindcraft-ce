import type { Settings } from './src/types/common.js';

const settings: Settings = {
    "minecraft_version": "auto", // or specific version like "1.21.11"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./profiles/opencode.json",
        // "./profiles/gpt.json",

        // 只有一个 OpenAI 兼容供应商：加 bot 就再加一个 profile，
        // 用 model.url 指到别的兼容端点即可（见 profiles/opencode.json）。
        // each profile spawns one standalone bot; bots do not talk to each other
        // individual profiles override values from the base profile
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "用中文回复hello world和你的名字", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "chat_ingame": true, // bot responses are shown in minecraft chat

    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_vision": true, // 每轮现拍示意图进 Live State 主循环（粗略重绘，大概看布局）
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // tools to disable.
    "cheat": false, // allow server-cheat shortcuts (/tp, /setblock, instant place) in skills. Requires OP.

    "max_messages": 15, // max number of messages to keep in context

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.

    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
