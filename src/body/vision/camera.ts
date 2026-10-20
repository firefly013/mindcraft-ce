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

import { remapChunkJson, remapBlockUpdateStateId } from './chunk_remap.js';
import type { FrameView } from './frame_record.js';
import { remapStateId, RENDERER_VERSION } from './state_remap.js';

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

// 朝向的类型在 `frame_record.ts`（纯逻辑，测试里不会把 `window` 带进来）。

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

    /** 是否装了"世界→渲染器"的 state 重映射（版本一致时不装）。 */
    stateRemapInstalled = false;

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
        this._installStateRemap(worldView);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
    }

    /**
     * **把世界版本的方块状态翻译成渲染器认识的 state id。**
     *
     * 为什么必须做：`prismarine-viewer` 的 `supportedVersions` 只到 1.21.4，世界的 1.21.11
     * 状态表它解不了（全表只有 9.6% 对、84.3% 被画成别的方块、6.1% 画「?」）。
     * 拦截点只有两处：`loadChunk`（整列）与 `blockUpdate`（增量）——**只翻 state id，不动结构**。
     *
     * 三条纪律：
     *   ① 世界/渲染器版本一致时**完全不插手**（零风险零开销）；
     *   ② 不能映射的 id 保持原值（渲染器画「?」，回执会如实计入），**绝不换成 0**（那会被画成空气）；
     *   ③ 永不抛 —— 重映射坏掉也只是"图更破"，不能让截图链断掉。
     */
    _installStateRemap (worldView: any): void {
        const worldVersion = String(this.bot?.version ?? '');
        if (worldVersion === '' || worldVersion === RENDERER_VERSION) return;
        const originalEmit = worldView.emit.bind(worldView);
        worldView.emit = (event: string, ...args: any[]): boolean => {
            try {
                if (event === 'loadChunk' && args[0] != null && args[0].chunk != null) {
                    args[0] = { ...args[0], chunk: remapChunkJson(args[0].chunk, remapStateId) };
                } else if (event === 'blockUpdate' && args[0] != null) {
                    const mapped = remapBlockUpdateStateId(args[0].stateId, remapStateId);
                    if (mapped !== args[0].stateId) args[0] = { ...args[0], stateId: mapped };
                }
            } catch {
                /* 翻译坏了就照原样发：图会更破，但绝不中断 */
            }
            return originalEmit(event, ...args);
        };
        this.stateRemapInstalled = true;
    }

    /**
     * 拍一张。
     *
     * **返回文件名 + 这一帧自己的朝向**：朝向在**渲染这一帧的那一行**读、
     * 和 `setFirstPersonCamera` 用的是**同一次读数**，所以回执里说"这张图朝哪"
     * 永远是**这一帧**的事实，不是"几秒后身体又转到哪了"（真机事故：
     * 快照说"朝天空（pitch −88°）"、图里却是水平隧道 ⇒ bot 正确地不信图、丢掉好画面）。
     */
    async capture(): Promise<{ file: string; view: FrameView }> {
        const center = new Vec3(this.bot.entity.position.x, this.bot.entity.position.y+this.bot.entity.height, this.bot.entity.position.z);
        this.viewer.camera.position.set(center.x, center.y, center.z);
        await this.worldView.updatePosition(center);
        // **这一帧的朝向**：就在喂给相机之前读一次，和下面 setFirstPersonCamera 同一个来源。
        const yaw = Number(this.bot.entity.yaw);
        const pitch = Number(this.bot.entity.pitch);
        this.viewer.setFirstPersonCamera(this.bot.entity.position, yaw, pitch);
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
        return {
            file: filename,
            // 读不到就记 null（回执会**什么都不说**，而不是拿当前朝向冒充这一帧）
            view: { yaw: Number.isFinite(yaw) ? yaw : null, pitch: Number.isFinite(pitch) ? pitch : null },
        };
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
