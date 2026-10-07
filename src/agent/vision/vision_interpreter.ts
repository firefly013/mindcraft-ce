import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';

export class VisionInterpreter {
    agent: any; // 交叉引用 Agent，避免循环依赖
    allow_vision: boolean;
    fp: string;
    camera: Camera | undefined;
    /** 最近一次拍摄，供 Live State 快照引用（文件名+拍摄时间）。 */
    lastScreenshot: { file: string; takenAt: number } | null = null;

    constructor(agent: any, allow_vision: boolean) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = './bots/'+agent.name+'/screenshots/';
        if (allow_vision) {
            this.camera = new Camera(agent.bot, this.fp);
        }
    }

    /**
     * 现拍一张返回 base64（主循环 Live State 用）。相机没开/没就绪/
     * 拍失败返回 null，调用方直接跳过图片——永不炸轮次。
     */
    async captureBase64(): Promise<string | null> {
        if (!this.allow_vision || !this.camera) return null;
        try {
            // 相机 init 是异步的（worldView 就绪才放行）：最多等 10 秒。
            const camera = this.camera;
            const deadline = Date.now() + 10000;
            while ((camera as { worldView?: unknown }).worldView == null && Date.now() < deadline) {
                await new Promise<void>((r) => setTimeout(r, 200));
            }
            if ((camera as { worldView?: unknown }).worldView == null) return null;
            const filename = await camera.capture();
            this.lastScreenshot = { file: filename, takenAt: Date.now() };
            return fs.readFileSync(`${this.fp}/${filename}.jpg`).toString('base64');
        } catch (err: unknown) {
            console.warn('Screenshot capture failed:', err instanceof Error ? err.message : String(err));
            return null;
        }
    }

    async lookAtPlayer(player_name: string, direction: string): Promise<string> {
        // **同一个毛病**：这里也被 `allow_vision` 挡住了（默认 false），于是
        // "看向某个玩家"从来没生效过。转头是机械动作，跟能不能截图无关。
        let result: string;
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;

        }

        // 分析走主循环截图直看，这里只给准星方块文本（下一轮截图即见所看）。
        return result + this.getCenterBlockInfo();
    }

    async lookAtPosition(x: number, y: number, z: number): Promise<string> {
        const bot = this.agent.bot;
        // **转头是纯机械动作，和"能不能截图"毫无关系** —— 原来它被 `allow_vision` 挡住了
        // （那个开关默认 false），于是这个工具**从来没转过一次头**，每次都返回同一句
        // "Vision is disabled."。模型真机报过 "lookAtPosition 转向不生效，两次调用逐字相同"。
        //
        // **瞄准点也要改**：原来瞄的是 `y + 2` —— 那是目标方块**上方 1.5 格**，
        // 准星自然对不上（模型真机一晚上的"桶灌不上 / 准星那块石头"都可能是它）。
        // 要对准方块**中心**：+0.5。
        await bot.lookAt(new Vec3(x + 0.5, y + 0.5, z + 0.5));
        // `lookAt` 是异步生效的（要等几个 tick 才反映到准星上），读之前让一步。
        await new Promise((resolve) => setTimeout(resolve, 150));
        
        // **以准星为地面真相**：`bot.blockAtCursor` 才是"我到底看着哪一格"，
        // 而那正是决定"动作成不成"的东西（模型 pib 说得对：视线不在方块上，
        // MC 客户端就不会发破坏包，超时是必然的）。
        //
        // 模型真机做过"先算后验"的对照：她手算 yaw=1.98、准星反推 1.96（**一致**），
        // 但 `bot.entity.yaw` 报 1.24（**差 42°**）—— 说明"瞄"是对的、"报朝向"的那个
        // 字段不可靠（它是服务端回显的，有延迟和量化）。所以回执的主判据是准星，
        // yaw/pitch 只作为参考读数附在后面。
        const pos = bot.entity?.position;
        const cursor: any = bot.blockAtCursor?.(128) ?? null;
        const cp = cursor?.position;
        const onTarget: boolean = cp != null && cp.x === x && cp.y === y && cp.z === z;
        const cursorText: string =
            cp == null
                ? '准星前方 128 格内没有方块'
                : `准星落在 ${cursor.name} @(${cp.x},${cp.y},${cp.z})`;
        const verdict: string = onTarget
            ? '✓ 就是你要的那一格'
            : `✗ 不是你要的 (${x},${y},${z}) —— 可能被挡、太远、或坐标不对；对准了再动手`;
        const facing: string = pos == null ? '' : `（参考读数：yaw ${(bot.entity.yaw ?? 0).toFixed(2)} pitch ${(bot.entity.pitch ?? 0).toFixed(2)}）`;
        return `Looking at ${x}, ${y}, ${z}（方块中心）。${cursorText} —— ${verdict}${facing}`;
        }

    getCenterBlockInfo(): string {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);

        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }
}
