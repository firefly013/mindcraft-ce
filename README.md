<div>
<h1 align="center">🧠Mindcraft CE⛏️</h1>


<p align="center">Crafting minds for Minecraft with LLMs and <a href="https://prismarinejs.github.io/mineflayer/#/">Mineflayer!</a></p>
<p align="center">The experimental version of <a href="https://github.com/mindcraft-bots/mindcraft">Mindcraft!</a>

<p align="center">
  <a href="docs/FAQ.md#common-issues">FAQ</a> | 
  <a href="https://discord.gg/mindcraft-ce">Discord Support</a> | 
  <a href="https://mindcraft-ce.com">Website</a>
<br>
  <a href="https://www.youtube.com/watch?v=gRotoL8P8D8">Video Tutorial</a> | 
  <a href="https://kolbynottingham.com/mindcraft/">Blog Post</a> | 
  <a href="https://mindcraft-minecollab.github.io/index.html">Paper Website</a> | 
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/minecollab.md">MineCollab</a>
</p>
</div>

> [!NOTE]
> 本分支已彻底移除大模型生成代码/代码执行（newAction/Coder/SES沙箱/execTemplate/lintTemplate），Bot 仅通过原生工具调用行动，不再在宿主机写码/跑码。

# New Experimental Features

Mindcraft CE is the experimental fork of Mindcraft, featuring unique implementations and unmerged PRs from the original repository. Each branch offers distinct features not found in others.

| Branch | Focus | Status | Key Features |
|--------|-------|--------|--------------|
| `stable` | Production ready | Stable | Confirmed working snapshot |
| [`develop`](#develop) | Active development | Beta | Upstream + extra/unique content |
| [`agent-system`](#agent-system) | AI tooling | Experimental | Function calling, RAG, tool-based prompting |

> [!Warning]
> Some of the new features may not work right, proceed at your own risk. If you encounter problems, consider contributing by submitting a pull request to the corresponding branch.

## Develop

This is the default branch, but you can still access it [here](https://github.com/mindcraft-ce/mindcraft-ce/tree/develop).

## Agent System

You can access this on the [agent-system](https://github.com/mindcraft-ce/mindcraft-ce/tree/agent-system) branch.

### 🔧 Function Calling
- **`use_function_calling`** — New tool-based AI interaction system in `settings.ts`
- Enables structured tool calls instead of text-based commands
- Supported across any OpenAI-compatible chat model

### 🧠 RAG System (Retrieval-Augmented Generation)
- **LanceDB Integration** — Vector database for intelligent context retrieval
- **RAGManager** — New class for handling memory and knowledge retrieval

### 🛠️ Tool-Based Prompting
- Modular prompt system with separate XML templates:
  - `conversing.xml`, `bot_responder.xml`
  - `image_analysis.xml`, `saving_memory.xml`
- `_default.tools.json` — New tool-based profile configuration
- `_default.commands.json` — Legacy command-based system (still supported)

### 👁️ Enhanced Vision & Models
- Improved vision request handling across all model providers

### 🎯 Other Improvements
- 🐳 Docker support with improved container configuration
- 📊 Multi-agent MineCollab framework
- 🌐 Bring your own OpenAI-compatible endpoint (any gateway or local server)

### 🚧 Coming Soon
- **Model Provider Repositories** — Install and update model providers from external repositories via `model_provider_repositories` in `settings.ts`
- **Tools Repositories** — Extend bot capabilities with community-created tools via `tools_provider_repositories` in `settings.ts`
- Both support auto-install/update and manual management through the Mindserver UI

# Getting Started
## Requirements

- [Minecraft Java Edition](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) (up to and including v1.21.11)
- [Node.js Installed](https://nodejs.org/) (Node.js 22 LTS, v22.13 or newer)
- An API key for the OpenAI-compatible endpoint you want to use. See [model customization](#model-customization). The default is the `opencode` gateway via `profiles/opencode.json` (key variable `OPENCODE_API_KEY`).

> [!Important]
> If installing node on windows, ensure you check `Automatically install the necessary tools`
>
> If you encounter `npm install` errors on macOS, see the [FAQ](docs/FAQ.md#common-issues) for troubleshooting native module build issues

## Install and Run

1. Make sure you have the requirements above.

2. Download the [latest release](https://github.com/mindcraft-ce/mindcraft-ce/releases/latest) and unzip it, or clone the repository.

3. Rename `keys.example.json` to `keys.json` and fill in your API keys (you only need one). The desired model is set in the default profile (`profiles/opencode.json`) or another profile. For other models refer to [model customization](#model-customization).

4. In terminal/command prompt, run `npm ci` from the installed directory (it installs the locked tree exactly). If you prefer `npm install`, you must pass `--legacy-peer-deps`: the declared `eslint` / `@eslint/js` pair has a peer conflict unrelated to this branch.

5. Start a minecraft world and open it to LAN on localhost port `55916`

6. Run `npm start` from the installed directory

If you encounter issues, check the [FAQ](docs/FAQ.md#common-issues) or find support on [discord](https://discord.gg/mindcraft-ce). We are currently not very responsive to github issues. To run tasks please refer to [Minecollab Instructions](docs/minecollab.md#installation)


# Configuration
## Model Customization

You can configure project details in `settings.ts`. [See file.](settings.ts)

You can configure the agent's name, model, and prompts in their profile like `profiles/opencode.json`. There is now a **single** model provider: **`openai`**, a generic OpenAI-compatible client, so any OpenAI-compatible endpoint can be used by setting a `url`.

To configure it, set the following in the profile's `model` object:

- **`api`** — always `"openai"`. Optional: it is inferred when omitted, and no other value is accepted.
- **`model`** — the model name sent to the endpoint.
- **`url`** — optional base URL of the endpoint (defaults to the OpenAI API).
- **`params`** — optional; every key is passed straight into the request body (e.g. `temperature`, or `thinking: { "type": "disabled" }`), plus two special keys:
  - **`headers`** — an object of extra HTTP headers to send with every request. A value may contain `${VAR}`: the variable is read from the environment, or replaced with a fresh UUID when unset (used for per-process session ids).
  - **`api_key_env`** — the name of the `keys.json` / environment variable holding the API key (default `OPENAI_API_KEY`).

You will need the API key named by `api_key_env` for the endpoint you choose.

For a local server that needs no key (LM Studio, vLLM's OpenAI-compatible port, …) you may leave the
key variable unset as long as a custom `url` is set: the client falls back to a placeholder key
instead of refusing to start. Without a custom `url`, a missing `OPENAI_API_KEY` is still a hard error.

### Worked Examples

Minimal form — `profiles/gpt.json` (`api` is omitted; with a single provider it defaults to `openai`):

```json
{
    "name": "gpt",
    "model": {
        "model": "gpt-5.4",
        "params": {
            "reasoning": { "effort": "low" }
        }
    }
}
```

Custom endpoint, key variable and headers — `profiles/opencode.json` (the OpenCode Zen gateway):

```json
{
    "name": "opencode",
    "model": {
        "api": "openai",
        "model": "deepseek-v4.1-flash",
        "url": "https://opencode.ai/zen/go/v1",
        "params": {
            "api_key_env": "OPENCODE_API_KEY",
            "headers": { "x-opencode-session": "${OPENCODE_SESSION_ID}" },
            "thinking": { "type": "disabled" }
        }
    }
}
```

Any other OpenAI-compatible service is configured the same way: point `url` at its base URL and set `api_key_env` if its key is not stored in `OPENAI_API_KEY`. There is no provider-specific adapter to add or select.


For more comprehensive model configuration and syntax, see [Model Specifications](#model-specifications).

For local models, use any OpenAI-compatible local server (LM Studio, vLLM, Ollama's OpenAI-compatible endpoint, …) and point the generic `openai` provider at its `url`. Ollama's native (non-OpenAI) API is not supported.
Please see our [huggingface page for more info.](https://huggingface.co/collections/Mindcraft-CE)

## Online Servers
To connect to online servers your bot will need an official Microsoft/Minecraft account. You can use your own personal one, but will need another account if you want to connect too and play with it. To connect, change these lines in `settings.ts`:
```javascript
"host": "111.222.333.444",
"port": 55920,
"auth": "microsoft",

// rest is same...
```
> [!Important]
> The bot's name in the profile.json must exactly match the Minecraft profile name! Otherwise the bot will spam talk to itself.

To use different accounts, Mindcraft will connect with the account that the Minecraft launcher is currently using. You can switch accounts in the launcher, then run `npm start`, then switch to your main account after the bot has connected.

## Tasks

Tasks automatically start the bot with a prompt and a goal item to acquire. To run a simple task that involves collecting 4 oak_logs run 

`npm start -- --task_path tasks/basic/single_agent.json --task_id gather_oak_logs`

Here is an example task json format: 

```json
{
    "gather_oak_logs": {
      "goal": "Collect at least four logs",
      "initial_inventory": {
        "0": {
          "wooden_axe": 1
        }
      },
      "agent_count": 1,
      "target": "oak_log",
      "number_of_target": 4,
      "type": "techtree",
      "max_depth": 1,
      "depth": 0,
      "timeout": 300,
      "blocked_actions": {
        "0": [],
        "1": []
      },
      "missing_items": [],
      "requires_ctable": false
    }
}
```

The `initial_inventory` is what the bot will have at the start of the episode, `target` refers to the target item and `number_of_target` refers to the number of target items the agent needs to collect to successfully complete the task. 

If you want more optimization and automatic launching of the minecraft world, you will need to follow the instructions in [Minecollab Instructions](docs/minecollab.md#installation)

## Docker Container

Run the app in a docker container when connecting to remote servers.

```bash
docker build -t mindcraft . && docker run --rm --add-host=host.docker.internal:host-gateway -p 8080:8080 -p 3000-3003:3000-3003 -e SETTINGS_JSON='{"auto_open_ui":false,"profiles":["./profiles/opencode.json"],"host":"host.docker.internal"}' --volume ./keys.json:/app/keys.json --name mindcraft mindcraft
```
or simply
```bash
docker-compose up --build
```

When running in docker, if you want the bot to join your local minecraft server, you have to use a special host address `host.docker.internal` to call your localhost from inside your docker container. Put this into your [settings.ts](settings.ts):

```javascript
"host": "host.docker.internal", // instead of "localhost", to join your local minecraft from inside the docker container
```

To connect to an unsupported minecraft version, you can try to use [viaproxy](services/viaproxy/README.md)

# Bot Profiles

Bot profiles are json files (such as `profiles/opencode.json`) that define:

1. Bot backend LLMs to use for talking and embedding.
2. Prompts used to influence the bot's behavior.
3. Examples help the bot perform tasks.

## Model Specifications

LLM models can be specified simply as `"model": "gpt-5.4"`, or more specifically with `"{api}/{model}"`, like `"openai/deepseek-v4.1-flash"`. See [model customization](#model-customization) for the single supported API.

The `model` field can be a string or an object. A model object may specify an `api` (always `"openai"`), a `model`, a `url`, and additional `params`. See the example below.

```json
"model": {
  "api": "openai",
  "model": "gpt-5.4",
  "url": "https://api.openai.com/v1/",
  "params": {
    "max_tokens": 1000,
    "temperature": 1
  }
}
```

There is no separate vision model: the round screenshot is attached to the same chat model each turn, so pick a model that supports images if you want the bot to use them.

`url` and `params` are optional, so `model` is the only required field. The `params` field accepts any key-value pairs supported by the endpoint, plus the special `headers` and `api_key_env` keys described in [model customization](#model-customization).

> If your endpoint does not need an API key (a local LM Studio / vLLM / Ollama server, for example), you can leave `api_key_env` pointing at a variable that is not set — the client falls back to a placeholder key. Pointing at the official OpenAI endpoint without a key is still an error.

## Specifying Profiles via Command Line

By default, the program will use the profiles specified in `settings.ts`. You can specify one or more agent profiles using the `--profiles` argument: `npm start -- --profiles ./profiles/opencode.json ./profiles/jill.json`


# Contributing

We welcome contributions to the project! We are generally less responsive to github issues, and more responsive to pull requests. Join the [discord](https://discord.gg/mindcraft-ce) for more active support and direction.

While AI generated code is allowed, please vet it carefully. Submitting tons of sloppy code and documentation actively harms development.

## Patches

Some of the node modules that we depend on have bugs in them. To add a patch, change your local node module file and run `npx patch-package [package-name]`

## Development Team
[@Sweaterdog](https://github.com/Sweaterdog) | [@riqvip](https://github.com/riqvip) | [@uukelele](https://github.com/uukelele) | [@mrelmida](https://github.com/mrelmida)


Also thanks to all the other developers of the Mindcraft project: [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), [@kolbytn](https://github.com/kolbytn), [@icwhite](https://github.com/icwhite), [@Ninot1Quyi](https://github.com/Ninot1Quyi)



## Citation:
This work is published in the paper [Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning](https://arxiv.org/abs/2504.17950). Please use this citation if you use this project in your research:
```
@article{mindcraft2025,
  title = {Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning},
  author = {White*, Isadora and Nottingham*, Kolby and Maniar, Ayush and Robinson, Max and Lillemark, Hansen and Maheshwari, Mehul and Qin, Lianhui and Ammanabrolu, Prithviraj},
  journal = {arXiv preprint arXiv:2504.17950},
  year = {2025},
  url = {https://arxiv.org/abs/2504.17950},
}
```

## Contributors

Thanks to everyone who has submitted issues on and off Github, made suggestions, and generally helped make this a better project.

![Contributors](https://contrib.rocks/image?repo=mindcraft-ce/mindcraft-ce)
