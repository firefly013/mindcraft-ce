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

    async lookAtPlayer(player_name: string, direction: string): Promise<string> {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result: string;
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename: string;
        const camera = this.camera;
        if (!camera) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await camera.capture();
            this.lastScreenshot = { file: filename, takenAt: Date.now() };
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await camera.capture();
            this.lastScreenshot = { file: filename, takenAt: Date.now() };

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x: number, y: number, z: number): Promise<string> {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        const result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        const camera = this.camera;
        if (!camera) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        const filename = await camera.capture();
        this.lastScreenshot = { file: filename, takenAt: Date.now() };

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
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

    async analyzeImage(filename: string): Promise<string> {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error: unknown) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
}
