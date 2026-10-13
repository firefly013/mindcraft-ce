// Untyped third-party Minecraft / LLM helper modules.
// Each shorthand `declare module 'x';` gives the import an `any` type,
// which is the pragmatic choice for libraries that ship no types.
// As typed wrappers are added, replace the corresponding line with a real signature.

// --- Minecraft stack (no bundled types) ---
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
declare module 'minecraft-assets';
declare module 'node-canvas-webgl';
declare module 'node-canvas-webgl/lib/index.js';
declare module 'vec3';

// minecraft-data ships its own types in newer versions but older
// @types are inconsistent across mirrors; keep it `any` for stability.
declare module 'minecraft-data';
