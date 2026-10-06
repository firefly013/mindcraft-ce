// 给两个 bot 发消息（开发者通道）。用法：node say.cjs <pia|pib|all> "消息"
// 追加到 bots/<name>/inbox.txt；agent 每个 tick 读新增行，立刻当 L3 投进去。
const { appendFileSync, mkdirSync } = require('node:fs');
const [who, text] = process.argv.slice(2);
if (!who || !text) {
  console.error('用法: node say.cjs <pia|pib|all> "消息"');
  process.exit(1);
}
const targets = who === 'all' ? ['pia', 'pib'] : [who];
for (const t of targets) {
  mkdirSync(`bots/${t}`, { recursive: true });
  appendFileSync(`bots/${t}/inbox.txt`, `${text}\n`);
  console.log(`  -> ${t}: ${text}`);
}
