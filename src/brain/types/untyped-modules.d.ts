// 大脑侧用到的、不带类型声明的第三方模块。
//
// MindServer 的 Web UI 要给方块/物品取贴图，所以它会 `await import('minecraft-assets')`
// （见 `mindserver.ts` 的 `/texture/:name` 路由）。这个包不发类型，声明留一份
// `any` 在这里——它是大脑**唯一**接触 Minecraft 生态的地方，而且只是静态贴图，
// 与身体那边的 mineflayer 客户端毫无关系。

declare module 'minecraft-assets';
