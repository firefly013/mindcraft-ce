/**
 * 构建收尾：把 MindServer 的静态资源拷进 `dist/`。
 *
 * 为什么需要它：`tsc` 只处理它能 import 的东西——`.ts` 和（`resolveJsonModule`
 * 下的）`.json`。`index.html` 是 express 用 `express.static(public/)` 直接读的，
 * 从来没被 import 过，所以只跑 `tsc` 的话 `dist/src/brain/mindserver/public/`
 * 里只有 `settings_spec.json`：`npm run start:build` 起得来，但 UI 是 404。
 *
 * 这条不是这次目录重构引入的（旧布局 `src/mindcraft/public/` 时代就是这样），
 * 但既然是"构建产物能不能跑"的问题，就别留着。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const from = resolve('src/brain/mindserver/public');
const to = resolve('dist/src/brain/mindserver/public');

if (!existsSync(from)) {
  console.error(`静态资源目录不存在：${from}`);
  process.exit(1);
}
mkdirSync(dirname(to), { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
