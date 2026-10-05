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
     * 现拍一张返回 base64（主循环 Live State 用）。相机没开/拍失败
     * 返回 null，调用方直接跳过图片——永不炸轮次。
     */
    async captureBase64(): Promise<string | null> {
        if (!this.allow_vision || !this.camera) return null;
        try {
            const filename = await this.camera.capture();
            this.lastScreenshot = { file: filename, takenAt: Date.now() };
            return fs.readFileSync(`${this.fp}/${filename}.jpg`).toString('base64');
        } catch (err: unknown) {
            console.warn('Screenshot capture failed:', err instanceof Error ? err.message : String(err));
            return null;
        }
    }

    async lookAtPlayer(player_name: string, direction: string): Promise<string> {
        if (!this.allow_vision) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
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
        if (!this.allow_vision) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        const result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        return result + this.getCenterBlockInfo();
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
