// 开发者通道：给跑着的 bot 发消息。
//
//   node scripts/say.mjs <pia|pib|all> "消息"
//
// 追加到 `bots/<name>/inbox.txt`，agent 每个 tick 读新增行、立刻当 L3 投进去
// （见 `Agent.pollInbox`）。为什么走文件而不是进服聊天：临时起 mineflayer 客户端
// 在这台服务器上会卡在握手，而文件通道不依赖协议细节，脚本能写、也能一次发两个。
import { appendFileSync, mkdirSync } from 'node:fs';

const [who, ...rest] = process.argv.slice(2);
const text = rest.join(' ');
if (!who || text === '') {
  console.error('用法: node scripts/say.mjs <pia|pib|all> "消息"');
  process.exit(1);
}
const targets = who === 'all' ? ['pia', 'pib'] : [who];
for (const target of targets) {
  mkdirSync(`bots/${target}`, { recursive: true });
  appendFileSync(`bots/${target}/inbox.txt`, `${text}\n`);
  console.log(`  -> ${target}: ${text}`);
}
