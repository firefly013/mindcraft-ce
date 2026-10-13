// 身体侧用到的、不带类型声明的第三方模块。
//
// 每条 `declare module 'x';` 把 import 变成 `any`——对"上游不发类型"的库是
// 务实的选择。将来补上真实类型包装时，把对应那行换掉即可。
//
// **这份文件住在身体目录里**：下面全是 Minecraft 客户端侧的库（mineflayer 及其
// 插件、prismarine-*、minecraft-data）。大脑进程不 import 任何一个
// （`tests/isolation.test.ts` 会验证这件事），所以它们的类型声明也不该出现在
// 共享层——声明住哪，边界就画在哪。

declare module 'mineflayer';
declare module 'mineflayer-pathfinder';
declare module 'mineflayer-collectblock';
declare module 'mineflayer-auto-eat';
declare module 'mineflayer-armor-manager';
declare module '@nxg-org/mineflayer-common-sense';
declare module '@nxg-org/mineflayer-custom-pvp';
declare module 'prismarine-viewer';
declare module 'prismarine-viewer/viewer/lib/viewer.js';
declare module 'prismarine-viewer/viewer/lib/worldView.js';
declare module 'prismarine-viewer/viewer/lib/simpleUtils.js';
declare module 'prismarine-item';
declare module 'node-canvas-webgl';
declare module 'node-canvas-webgl/lib/index.js';
declare module 'vec3';

// minecraft-data ships its own types in newer versions but older
// @types are inconsistent across mirrors; keep it `any` for stability.
declare module 'minecraft-data';
