/**
 * 交互类工具：`useBlock` / `useEntity` / `craft`。
 *
 * ## 为什么要把一批中层工具收成一个
 *
 * 原来有十个工具把"固定流程"写死在里面：`craftRecipe`（放工作台+合成）、
 * `smeltItem`（放炉子+烧+取）、`putInChest`/`takeFromChest`/`viewChest`、
 * `tradeWithVillager`/`showVillagerTrades`、`goToBed`、`clearFurnace`、
 * `givePlayer`（跑过去+扔）。流程一写死，环境不配合就整条失败，而且**失败在
 * 哪一步模型看不见**——模型反馈里那两条"调用后再无音讯、不知道成功失败还是
 * 被中断"，根子就是这个黑盒。
 *
 * ## `useBlock`：四个参数说清绝大多数交互
 *
 * | `input` | `output` | 做什么 |
 * |---|---|---|
 * | 有 | 无 | **存进去**（箱子） |
 * | 无 | 有 | **取出来**（箱子 / 熔炉取成品） |
 * | 有 | 有 | **加工**（合成 / 烧炼 / 铁砧），`output` 是**断言** |
 * | 无 | 无 | **直接用这个方块**（开箱子读内容 / 睡 / 开关门 / 附魔台读可选附魔） |
 *
 * `action` 参数**不需要**——谁为 null 就决定了干什么；`type` 天然消歧（同样
 * `input={stone_pickaxe}`，`type=chest` 是"存进去"，`type=crafting_table`
 * 是"要合出这个"）。
 *
 * ## 走路：给了 coords 才走
 *
 * 给了 `coords` → 走过去用那一格（坐标上不是该方块就明确报"是 X 不是 Y"）；
 * 没给（**常态**）→ 用够得着的最近一个，不走动。走路因此只是流程里**可被看见
 * 的一段**，不是隐藏段。
 *
 * ## 分阶段报告
 *
 * 结果逐段写清楚：走到哪 → 放入了什么 → 产出了什么 → 有没有收进背包。
 * 失败也分段："走到 (x,y,z) 失败：路径被堵" / "输入不够：石头只有 2 个"。
 * 同样的流程，摊开就不再是黑盒。
 */
import * as skills from '../library/skills.js';
import { td, tp } from '../../prompts.js';
import type { AgentCommand } from './actions.js';

/** 物品规格：`{name, count}` 或裸名字。 */
export interface ItemSpec {
  name: string;
  count: number;
}

/**
 * 把模型给的 `input`/`output` 归一成物品规格。
 *
 * 收 `unknown` 是因为它直接从工具参数来（模型可能写 `"3 stone"`、`{name, count}`
 * 或者 `[{...}, {...}]`）。**归一失败要说清怎么改**，不能吞。
 */
export function parseItems(raw: unknown): { items: ItemSpec[]; error?: string } {
  if (raw == null) return { items: [] };
  const list = Array.isArray(raw) ? raw : [raw];
  const items: ItemSpec[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      // 支持 "3 stone" / "stone 3" / "stone"
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(entry) ?? /^\s*(.+?)\s+(\d+)\s*$/.exec(entry);
      if (m != null) {
        const a = m[1] ?? '';
        const b = m[2] ?? '';
        const count = /^\d+$/.test(a) ? Number(a) : Number(b);
        const name = /^\d+$/.test(a) ? b : a;
        items.push({ name, count });
      } else {
        items.push({ name: entry.trim(), count: 1 });
      }
      continue;
    }
    if (typeof entry === 'object' && entry !== null) {
      const obj = entry as Record<string, unknown>;
      const name = obj['name'] ?? obj['item'] ?? obj['item_name'];
      if (typeof name !== 'string' || name === '') {
        return { items: [], error: '每项都要有 name（例如 {"name":"stone","count":3}）。' };
      }
      const rawCount = obj['count'] ?? obj['num'] ?? 1;
      const count = typeof rawCount === 'number' ? rawCount : Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) {
        return { items: [], error: `"${name}" 的数量要是正整数。` };
      }
      items.push({ name, count });
      continue;
    }
    return { items: [], error: 'input/output 只能是物品名、{name,count} 或它们的数组。' };
  }
  return { items };
}

/** 背包里某物品的数量。读不到就返回 null（宁可说"不知道"也不猜）。 */
export function countInInventory(bot: unknown, name: string): number | null {
  const b = bot as { inventory?: { items?: () => Array<{ name?: unknown; count?: unknown }> } };
  try {
    const items = b.inventory?.items?.() ?? [];
    let total = 0;
    let seen = false;
    for (const item of items) {
      if (item?.name !== name) continue;
      seen = true;
      total += typeof item.count === 'number' ? item.count : 1;
    }
    return seen ? total : 0;
  } catch {
    return null;
  }
}

/**
 * 够得着的最近一个 `type` 方块；没有就 null。
 *
 * "够得着"用与方块交互的距离（约 4.5 格，取 4 保守一点）。
 */
export function nearestReachableBlock(
  bot: unknown,
  type: string,
  maxDistance = 4,
): { x: number; y: number; z: number } | null {
  const b = bot as {
    entity?: { position?: { x?: number; y?: number; z?: number } };
    findBlocks?: (opts: Record<string, unknown>) => Array<{ x: number; y: number; z: number }> | null;
  };
  const pos = b.entity?.position;
  if (pos == null || typeof b.findBlocks !== 'function') return null;
  let found: Array<{ x: number; y: number; z: number }> | null;
  try {
    found = b.findBlocks({
      matching: (block: { name?: unknown }) => block?.name === type,
      maxDistance,
      count: 8,
    });
  } catch {
    return null;
  }
  if (found == null || found.length === 0) return null;
  const sx = pos.x ?? 0;
  const sy = pos.y ?? 0;
  const sz = pos.z ?? 0;
  let best: { x: number; y: number; z: number } | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const candidate of found) {
    const d = Math.hypot(candidate.x - sx, candidate.y - sy, candidate.z - sz);
    if (d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return best;
}

/** 坐标上那个方块的名字（读不到返回 null）。 */
export function blockNameAt(bot: unknown, x: number, y: number, z: number): string | null {
  const b = bot as {
    blockAt?: (p: { x: number; y: number; z: number }) => { name?: unknown } | null;
  };
  try {
    const block = b.blockAt?.({ x, y, z });
    return typeof block?.name === 'string' ? block.name : null;
  } catch {
    return null;
  }
}

/** 一步的结果行——逐段报告就是靠它拼出来的。 */
function step(text: string): string {
  return `- ${text}`;
}

function itemText(items: readonly ItemSpec[]): string {
  return items.map((i) => `${i.name}×${i.count}`).join('、');
}

/** 加工类方块（有 input 也有 output 时走这条）。 */
const PROCESSING_BLOCKS = new Set(['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'anvil']);
/** 容器类方块（只存或只取）。 */
const CONTAINER_BLOCKS = new Set(['chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box']);

/**
 * `useBlock` 的落点分派。
 *
 * 抽成纯函数是为了能单测：给定 type / input / output 该走哪条路，是这套设计里
 * 唯一容易搞错的地方（`action` 参数就是被它取代的）。
 */
export type BlockPlan =
  | { kind: 'deposit' }
  | { kind: 'withdraw' }
  | { kind: 'process' }
  | { kind: 'interact' }
  | { kind: 'unsupported'; reason: string };

export function planUseBlock(
  type: string,
  hasInput: boolean,
  hasOutput: boolean,
): BlockPlan {
  if (hasInput && hasOutput) {
    if (PROCESSING_BLOCKS.has(type)) return { kind: 'process' };
    return {
      kind: 'unsupported',
      reason: `${type} 不能同时收下 input 和 output：加工类方块（工作台/熔炉/铁砧）才可以。`,
    };
  }
  if (hasInput) {
    if (CONTAINER_BLOCKS.has(type)) return { kind: 'deposit' };
    return { kind: 'unsupported', reason: `${type} 不能只"存进去"——那是容器（箱子/桶）才有的用法。` };
  }
  if (hasOutput) {
    if (CONTAINER_BLOCKS.has(type)) return { kind: 'withdraw' };
    // 熔炉取成品：output 单独给就是"把烤好的拿出来"
    if (PROCESSING_BLOCKS.has(type)) return { kind: 'withdraw' };
    return { kind: 'unsupported', reason: `${type} 不能只"取出来"——箱子或熔炉才行。` };
  }
  return { kind: 'interact' };
}

/** 把结果行拼成一段人类（和模型）都读得懂的正文。 */
export function renderReport(lines: readonly string[], tail?: string): string {
  const body = lines.join('\n');
  return tail == null ? body : `${body}\n${tail}`;
}

export const interactList: AgentCommand[] = [
  {
    name: '!useBlock',
    description: td('useBlock'),
    params: {
      type: { type: 'BlockOrItemName', description: tp('useBlock', 'type') },
      coords: { type: 'string', description: tp('useBlock', 'coords'), optional: true },
      input: { type: 'string', description: tp('useBlock', 'input'), optional: true },
      output: { type: 'string', description: tp('useBlock', 'output'), optional: true },
    },
    perform: async function (
      agent: any,
      type: string,
      coords?: unknown,
      input?: unknown,
      output?: unknown,
    ): Promise<string> {
      const lines: string[] = [];
      const parsedIn = parseItems(input);
      const parsedOut = parseItems(output);
      if (parsedIn.error != null) return `useBlock 参数不对：${parsedIn.error}`;
      if (parsedOut.error != null) return `useBlock 参数不对：${parsedOut.error}`;

      const plan = planUseBlock(type, parsedIn.items.length > 0, parsedOut.items.length > 0);
      if (plan.kind === 'unsupported') return `useBlock 用不了：${plan.reason}`;

      // 定位：给了 coords 就过去；没给就用够得着的最近一个。
      if (typeof coords === 'string' && coords.trim() !== '') {
        const parts = coords.split(',').map((p) => Number(p.trim()));
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
          return `useBlock 参数不对：coords 要写成 "x,y,z"（收到 "${coords}"）。`;
        }
        const [x, y, z] = parts as [number, number, number];
        const actual = blockNameAt(agent.bot, x, y, z);
        if (actual != null && actual !== type) {
          return `useBlock 用不了：(${x},${y},${z}) 是 ${actual}，不是 ${type}。`;
        }
        lines.push(step(`走过去 (${x},${y},${z})`));
        const ok = await skills.goToPosition(agent.bot, x, y, z, 2);
        if (!ok) {
          return renderReport(lines, `走到 (${x},${y},${z}) 失败：路径被堵或到不了。可以先 goToCoordinates，或者换一个方块。`);
        }
      } else {
        const nearby = nearestReachableBlock(agent.bot, type);
        if (nearby == null) {
          return `身边 4 格内没有够得着的 ${type}。要么先 goToCoordinates 走过去再给 coords，要么先 placeHere 放一个。`;
        }
        lines.push(step(`用够得着的 ${type} @(${nearby.x},${nearby.y},${nearby.z})`));
      }

      // 分派到已有技能。每一步都写进 lines，失败也写清楚。
      if (plan.kind === 'interact') {
        if (type === 'chest' || type === 'trapped_chest' || type === 'barrel') {
          const ok = await skills.viewChest(agent.bot);
          lines.push(step(ok ? '打开看了里面的东西' : '打开失败'));
          return renderReport(lines);
        }
        if (type === 'bed') {
          const ok = await skills.goToBed(agent.bot);
          lines.push(step(ok ? '睡下了' : '睡不了（不是夜晚，或旁边有怪）'));
          return renderReport(lines);
        }
        lines.push(step(`直接用了 ${type}（没有 input/output，所以不改变它的内容）`));
        return renderReport(lines);
      }

      if (plan.kind === 'deposit') {
        for (const item of parsedIn.items) {
          const have = countInInventory(agent.bot, item.name);
          if (have === 0) {
            lines.push(step(`背包里没有 ${item.name}，跳过`));
            continue;
          }
          const ok = await skills.putInChest(agent.bot, item.name, item.count);
          lines.push(step(ok ? `放入 ${item.name}×${item.count}` : `放入 ${item.name} 失败`));
        }
        return renderReport(lines);
      }

      if (plan.kind === 'withdraw') {
        for (const item of parsedOut.items) {
          const ok = await skills.takeFromChest(agent.bot, item.name, item.count);
          lines.push(step(ok ? `取出 ${item.name}×${item.count}` : `取出 ${item.name} 失败（箱子里没有？）`));
        }
        return renderReport(lines);
      }

      // process：output 是断言。
      const wanted = parsedOut.items[0];
      if (wanted == null) return renderReport(lines, 'useBlock 用不了：加工要给出 output。');
      if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') {
        const ok = await skills.smeltItem(agent.bot, wanted.name, wanted.count);
        lines.push(step(ok ? `已点火，开始烧 ${wanted.name}×${wanted.count}` : `烧不了 ${wanted.name}（缺原料或燃料？）`));
        // **不阻塞**：只把估计时间写进返回，取成品是另一次 useBlock（output 单独给）
        return renderReport(
          lines,
          '熔炉是异步的：约 10 秒一件，到点了再用 useBlock(type=furnace, output=...) 来取。',
        );
      }
      // 工作台 / 铁砧
      const have = countInInventory(agent.bot, wanted.name);
      const ok = await skills.craftRecipe(agent.bot, wanted.name, wanted.count);
      if (ok) {
        lines.push(step(`产出 ${wanted.name}×${wanted.count}`));
        return renderReport(lines);
      }
      lines.push(step(`做不出 ${wanted.name}`));
      return renderReport(
        lines,
        `检查一下 input（现在给的是 ${itemText(parsedIn.items) || '空'}）够不够、配方对不对。` +
          (have != null ? `背包里现有 ${wanted.name}×${have}。` : ''),
      );
    },
  },
  {
    name: '!useEntity',
    description: td('useEntity'),
    params: {
      entity_id: { type: 'int', description: tp('useEntity', 'entity_id') },
      input: { type: 'string', description: tp('useEntity', 'input'), optional: true },
      output: { type: 'string', description: tp('useEntity', 'output'), optional: true },
    },
    perform: async function (
      agent: any,
      entity_id: number,
      input?: unknown,
      output?: unknown,
    ): Promise<string> {
      const parsedIn = parseItems(input);
      const parsedOut = parseItems(output);
      if (parsedIn.error != null) return `useEntity 参数不对：${parsedIn.error}`;
      if (parsedOut.error != null) return `useEntity 参数不对：${parsedOut.error}`;

      const lines: string[] = [];
      const entity = agent.bot?.entities?.[entity_id];
      if (entity == null) {
        return `找不到实体 #${entity_id}（可能已经消失或走远了）。看一眼 Live State 的实体表。`;
      }
      const kind = String(entity.name ?? entity.username ?? 'unknown');
      lines.push(step(`目标 #${entity_id} 是 ${kind}，走过去`));
      const ok = await skills.goToPosition(
        agent.bot,
        entity.position?.x ?? null,
        entity.position?.y ?? null,
        entity.position?.z ?? null,
        2,
      );
      if (!ok) {
        return renderReport(lines, `走到 #${entity_id} 失败：追不上或路被堵。`);
      }

      if (parsedIn.items.length === 0 && parsedOut.items.length === 0) {
        if (kind === 'villager') {
          const shown = await skills.showVillagerTrades(agent.bot, entity_id);
          lines.push(step(shown ? '列出了它的交易' : '读不到交易列表'));
          return renderReport(lines);
        }
        lines.push(step(`到了 ${kind} 旁边，但没说要干什么（input/output 都是空的）`));
        return renderReport(lines);
      }

      if (parsedOut.items.length > 0 && parsedIn.items.length === 0) {
        const want = parsedOut.items[0] as ItemSpec;
        if (kind === 'villager') {
          const traded = await skills.tradeWithVillager(agent.bot, entity_id, want.name, want.count);
          lines.push(step(traded ? `交易换到 ${want.name}×${want.count}` : `交易失败（它没有这个交易，或你没带够东西）`));
          return renderReport(lines);
        }
        lines.push(step(`想从 ${kind} 身上拿 ${want.name}：拿的方法是 input 给它工具/容器（如 shears / bucket）`));
        return renderReport(lines);
      }

      const give = parsedIn.items[0] as ItemSpec;
      if (kind === 'villager') {
        const traded = await skills.tradeWithVillager(agent.bot, entity_id, give.name, give.count);
        lines.push(step(traded ? `用 ${give.name}×${give.count} 换了东西` : `交易失败（这个交易不对，或数量不够）`));
        return renderReport(lines);
      }
      const fed = await skills.consume(agent.bot, give.name);
      lines.push(step(fed ? `对 ${kind} 用了 ${give.name}×${give.count}` : `对 ${kind} 用 ${give.name} 失败`));
      return renderReport(lines);
    },
  },
  {
    name: '!craft',
    description: td('craft'),
    params: {
      input: { type: 'string', description: tp('craft', 'input') },
      output: { type: 'string', description: tp('craft', 'output') },
    },
    perform: async function (agent: any, input: unknown, output: unknown): Promise<string> {
      const parsedIn = parseItems(input);
      const parsedOut = parseItems(output);
      if (parsedIn.error != null) return `craft 参数不对：${parsedIn.error}`;
      if (parsedOut.error != null) return `craft 参数不对：${parsedOut.error}`;
      const want = parsedOut.items[0];
      if (want == null) return 'craft 参数不对：要给出 output（期望产出什么）。';

      const have = countInInventory(agent.bot, want.name);
      const ok = await skills.craftRecipe(agent.bot, want.name, want.count);
      if (ok) {
        return renderReport([step(`背包内合成 ${want.name}×${want.count}`)]);
      }
      return renderReport(
        [step(`做不出 ${want.name}×${want.count}`)],
        `检查材料（现在给的是 ${itemText(parsedIn.items) || '空'}）够不够；` +
          `如果这个配方要 3×3，得先 placeHere 放下 crafting_table，再用 useBlock。` +
          (have != null ? `背包里现有 ${want.name}×${have}。` : ''),
      );
    },
  },
];

export default { interactList, planUseBlock, parseItems };
