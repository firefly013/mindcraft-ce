import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';

import THREE from 'three';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import fs from 'fs/promises';
import { Buffer } from 'node:buffer';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';

import worker_threads from 'worker_threads';

// prismarine-viewer 的 viewer 内部用的是**全局** THREE / Worker
// （见 node_modules/prismarine-viewer/viewer/lib/entity/Entity.js 的 `/* global THREE */`）。
// 它自己的 headless 入口（lib/headless.js）会设置这两个全局，而我们只用了
// viewer/lib 的子路径，所以要自己装。
//
// 以前这里是靠 browser_viewer.ts 里那句 `import prismarine-viewer`（根模块会
// eager-require headless，从而设置全局）顺带装上的——**别把别人的副作用当依赖**：
// 删掉那个文件，截图链就静默断掉（屏幕全黑/报 THREE is not defined）。
(global as unknown as Record<string, unknown>).THREE = THREE;
(global as unknown as Record<string, unknown>).Worker = worker_threads.Worker;


export class Camera extends EventEmitter {
    bot: any; // mineflayer 无类型，bot 统一 any
    fp: string;
    viewDistance: number;
    width: number;
    height: number;
    canvas: any;
    renderer: any;
    viewer: any;
    worldView: any;

    constructor (bot: any, fp: string) {
        super();
        this.bot = bot;
        this.fp = fp;
        this.viewDistance = 12;
        this.width = 800;
        this.height = 512;
        this.canvas = createCanvas(this.width, this.height);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
        this.viewer = new Viewer(this.renderer);
        this._init().then(() => {
            this.emit('ready');
        });
    }

    async _init (): Promise<void> {
        const botPos = this.bot.entity.position;
        const center = new Vec3(botPos.x, botPos.y+this.bot.entity.height, botPos.z);
        this.viewer.setVersion(this.bot.version);
        // Load world
        const worldView = new WorldView(this.bot.world, this.viewDistance, center);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
    }

    async capture(): Promise<string> {
        const center = new Vec3(this.bot.entity.position.x, this.bot.entity.position.y+this.bot.entity.height, this.bot.entity.position.z);
        this.viewer.camera.position.set(center.x, center.y, center.z);
        await this.worldView.updatePosition(center);
        this.viewer.setFirstPersonCamera(this.bot.entity.position, this.bot.entity.yaw, this.bot.entity.pitch);
        this.viewer.update();
        this.renderer.render(this.viewer.scene, this.viewer.camera);

        const imageStream = this.canvas.createJPEGStream({
            bufsize: 4096,
            quality: 100,
            progressive: false
        });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}`;

        const buf: Buffer = await getBufferFromStream(imageStream);
        await this._ensureScreenshotDirectory();
        await fs.writeFile(`${this.fp}/${filename}.jpg`, buf);
        console.log('saved', filename);
        return filename;
    }

    async _ensureScreenshotDirectory(): Promise<void> {
        let stats: { isDirectory(): boolean } | undefined;
        try {
            stats = await fs.stat(this.fp);
        } catch (e: unknown) {
            void e;
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp);
            }
        }
    }
}
