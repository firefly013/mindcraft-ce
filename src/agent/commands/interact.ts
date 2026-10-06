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
import Vec3 from 'vec3';
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
  const value = coerceJson(raw);
  if (value == null) return { items: [] };
  // **按逗号拆**：模型很自然会写 `"coal, stick"` / `"white_wool, white_wool, oak_planks"`。
  // 不拆的话整串会被当成**一个物品名**去找，回显就成了"去重成 ×1"——真机上两个模型
  // 都撞到这条，还各自做了对照实验来定位。
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.includes(',')
      ? value.split(',')
      : [value];
  const list = source.map((entry) => (typeof entry === 'string' ? entry.trim() : entry)).filter((entry) => entry !== '');
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

/**
 * 把一格里的东西挪到另一格。
 *
 * **逐级回退**：不同 mineflayer 版本把 `moveSlotItem` 放在不同地方——模型真机报过
 * `container.moveSlotItem is not a function`。所以依次试 window 上的、bot 上的，
 * 最后退到 `clickWindow` 的 shift 点击（整栈快速移动，够用且到处都有）。
 */
async function moveOne(bot: any, container: any, src: number, dest: number, count: number): Promise<void> {
  if (typeof container?.moveSlotItem === 'function') {
    await container.moveSlotItem(src, dest, count);
    return;
  }
  if (typeof bot?.moveSlotItem === 'function') {
    await bot.moveSlotItem(src, dest, count);
    return;
  }
  if (typeof bot?.clickWindow === 'function') {
    // mode 1 = shift 点击：整栈在背包与容器之间快速移动
    await bot.clickWindow(src, 0, 1);
    return;
  }
  throw new Error('这个 mineflayer 版本既没有 moveSlotItem 也没有 clickWindow，挪不了物品');
}

/**
 * 和容器（箱子/桶）之间挪物品。
 *
 * **故意不用 `skills.putInChest`/`takeFromChest`**：它们最终落到 mineflayer 的
 * `window.deposit`/`withdraw`，而那两个只在窗口的 `[inventoryStart, inventoryEnd]`
 * （箱子窗口是 `[27,63]`）里找物品。真机上模型撞到
 * `Can't find oak_log in slots [27 - 63]`，可 `findInventoryItem` 明明找得到——
 * 同一个物品，两条路结论相反。模型还做了对照：`"4 oak_log"` 失败、`"oak_log"`
 * 成功（两者只差 count），把这条 bug 钉得很死。
 *
 * 这里改成**自己扫全部背包槽**再 `moveSlotItem`，失败时把扫了哪些槽、每格是什么
 * 一并报出来——模型说光看 `[27 - 63]` 它完全没法自查。
 */
async function transferWithContainer(
  bot: any,
  chestBlock: { x: number; y: number; z: number },
  name: string,
  count: number,
  direction: 'deposit' | 'withdraw',
): Promise<{ ok: boolean; detail: string }> {
  let container: any;
  try {
    const ok = await skills.goToPosition(bot, chestBlock.x, chestBlock.y, chestBlock.z, 2);
    if (!ok) return { ok: false, detail: '走不到容器旁边' };
    // `openContainer` 要的是 **Block 对象**，不是 `{x,y,z}`——传裸坐标它会报
    // `containerToOpen is neither a block nor an entity`（模型真机报回来的）。
    // 而 `blockAt` 要的是 **Vec3**（内部会调 `.floored()`），传裸对象会报
    // `pos.floored is not a function`（模型紧接着报回来的第二条）。
    const block = bot.blockAt?.(new Vec3(chestBlock.x, chestBlock.y, chestBlock.z));
    if (block == null) return { ok: false, detail: `(${chestBlock.x},${chestBlock.y},${chestBlock.z}) 那里没有方块` };
    container = await bot.openContainer(block);
  } catch (error: unknown) {
    return { ok: false, detail: `打不开容器：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const slots: Array<{ name?: string; count?: number } | null> = container.slots ?? [];
    const invStart = Number(container.inventoryStart ?? 9);
    const invEnd = Number(container.inventoryEnd ?? slots.length);
    const boxStart = Number(container.containerStart ?? 0);
    const boxEnd = Number(container.containerEnd ?? invStart);
    const from = direction === 'deposit' ? { s: invStart, e: invEnd } : { s: boxStart, e: boxEnd };
    const to = direction === 'deposit' ? { s: boxStart, e: boxEnd } : { s: invStart, e: invEnd };

    // 源：按名字找（扫**全部**源槽，不看数量写法）
    const source: number[] = [];
    for (let i = from.s; i < Math.min(from.e, slots.length); i++) {
      if (slots[i]?.name === name) source.push(i);
    }
    if (source.length === 0) {
      return {
        ok: false,
        detail: `扫了源槽 [${from.s},${from.e}) 没找到 ${name}。手上/背包现有：` +
          slots
            .map((s, i) => (s?.name != null ? `${i}:${s.name}×${s.count ?? 1}` : null))
            .filter((s) => s != null)
            .slice(0, 24)
            .join(' '),
      };
    }

    let left = count <= 0 ? Number.MAX_SAFE_INTEGER : count;


    let moved = 0;


    const countOf = (idx: number): number => {


      const slot = container.slots?.[idx] as { name?: string; count?: number } | null | undefined;


      return slot != null && slot.name === name ? Number(slot.count ?? 0) : 0;


    };


    for (const src of source) {


      // **每一格搬到搬不动为止**。原来只调用一次 moveOne 就按请求量计数——模型真机


      // 报过"回执说挪了 cobblestone×408，开箱一看只进去 64 个（1 组）"：clickWindow


      // 的 shift 点击一次只搬**一栈**。所以搬完要**回头读容器**，按实际减少量计数。


      let guard = 0;


      while (left > 0 && guard++ < 24) {


        const have = countOf(src);


        if (have <= 0) break;


        const take = Math.min(left, have);


        let dest: number | null = null;


        for (let i = to.s; i < Math.min(to.e, slots.length); i++) {


          const target = container.slots?.[i] as { name?: string } | null | undefined;


          if (target == null) { dest = i; break; }


          if (target.name === name) { dest = i; break; }


        }


        if (dest == null) return { ok: moved > 0, detail: `挪了 ${moved} 个后目标槽满了` };


        await moveOne(bot, container, src, dest, take);


        const after = countOf(src);


        const actual = have - after;


        if (actual <= 0) break; // 没搬动，别死循环


        moved += actual;


        left -= actual;


      }


    }
    return { ok: moved > 0, detail: moved > 0 ? `挪了 ${name}×${moved}` : `没能挪动 ${name}` };
  } catch (error: unknown) {
    return { ok: false, detail: `挪物品时出错：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    try {
      await container?.close?.();
    } catch {
      /* 关不上就算了 */
    }
  }
}

/**
 * 给工具体加超时。
 *
 * 模型真机报过：`useBlock` 挂死 70s+、`Stop` 无效、"机器人被 useBlock 永久锁死，
 * 只能 restart"。原因是这三个新工具是**裸 async**，不像老工具那样包在
 * `ActionManager.runAction` 里，于是卡住就永远占着身体通道。
 *
 * 超时到点后 `ActionRunner.finish` 会继续走到 `releaseAction`，通道被放掉；
 * 同时给模型一句"超时了、卡在哪一步"——比静默锁死好得多。
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(onTimeout === undefined ? (undefined as T) : onTimeout);
        void error;
      },
    );
  });
}

/** 单次 useBlock/useEntity/craft 最多跑多久（毫秒）。 */
const TOOL_TIMEOUT_MS = 45_000;

/** 把一个容器槽描述成一行（空槽也说出来，别让人猜）。 */
function slotLine(slot: unknown, label: string): string {
  const s2 = slot as { name?: unknown; count?: unknown } | null | undefined;
  const name = typeof s2?.name === 'string' ? s2.name : null;
  if (name == null) return label + '：空';
  return label + '：' + name + '×' + String(s2?.count ?? 1);
}

/** 一步的结果行——逐段报告就是靠它拼出来的。 */
function step(text: string): string {
  return `- ${text}`;
}

/**
 * 跑一个技能，并把它自己写进 `bot.output` 的那几行**如实带回**。
 *
 * 为什么必须这样：技能内部 `log(bot, ...)` 写的是**具体原因**——"You have no
 * fuel to smelt X" / "You do not have enough raw_iron to smelt" / "The furnace
 * is currently smelting Y"。只看布尔值就会把真因换成一句笼统的"缺原料或燃料？"，
 * 真机上两个模型就是这样被误导的：它们交叉验证了 7 种写法，最后一起推断出
 * **错误的**根因（"熔炉需要原料槽+燃料槽两个入口"），还写进了正式反馈。
 * 同样的流程，摊开就不再是黑盒。
 */
async function runSkill(
  bot: unknown,
  lines: string[],
  fn: () => Promise<boolean>,
  okText: string,
  failText: string,
): Promise<boolean> {
  const read = (): string => String((bot as { output?: unknown })?.output ?? '');
  const before = read();
  // **超时兜底**：技能可能长时间不返回（`smeltItem` 会一直循环到全烧完——
  // 真机上就是它把通道占了 70s+，Stop 也没用）。到点就放弃，通道照样释放。
  const timedOut = Symbol('timeout');
  const ok = await withTimeout<boolean | typeof timedOut>(
    fn(),
    TOOL_TIMEOUT_MS,
    timedOut,
  );
  const after = read();
  const delta = (after.startsWith(before) ? after.slice(before.length) : after).trim();
  if (ok === timedOut) {
    lines.push(
      step(
        `${failText}：**超时**（${TOOL_TIMEOUT_MS / 1000} 秒没返回），已释放身体通道。` +
          '注意：**超时 ≠ 没做成**——熔炉这类异步动作常常已经投料成功、在后台继续跑（模型真机验证过：回执超时，但铁锭后来一个个到账）。先看一眼实际状态再决定要不要重试，别盲目重发。',
      ),
    );
    if (delta !== '') {
      for (const line of delta.split('\n')) {
        if (line.trim() !== '') lines.push(`    ${line.trim()}`);
      }
    }
    return false;
  }
  lines.push(step(ok ? okText : failText));
  if (delta !== '') {
    for (const line of delta.split('\n')) {
      if (line.trim() !== '') lines.push(`    ${line.trim()}`);
    }
  }
  return ok;
}

/**
 * 物品规格的容错解析。
 *
 * **必须容忍 JSON 字符串**：工具 schema 把 `input`/`output` 声明成 string，
 * 所以模型传数组时会被序列化成 `[{"name":"raw_copper","count":45},…]` 这样的
 * **一个字符串**。真机上模型按文档写了数组，工具却把整段 JSON 当成一个物品名
 * 去找，回"背包里没有 [{...}]"——模型自己把这条报上来了。
 */
function coerceJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const text = raw.trim();
  if (!text.startsWith('[') && !text.startsWith('{')) return raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
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
      let located: { x: number; y: number; z: number } | null;
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
        located = { x, y, z };
      } else {
        const nearby = nearestReachableBlock(agent.bot, type);
        if (nearby == null) {
          return `身边 4 格内没有够得着的 ${type}。要么先 goToCoordinates 走过去再给 coords，要么先 placeHere 放一个。`;
        }
        lines.push(step(`用够得着的 ${type} @(${nearby.x},${nearby.y},${nearby.z})`));
        located = nearby;
      }

      // 分派到已有技能。每一步都写进 lines，失败也写清楚。
      if (plan.kind === 'interact') {
        if (type === 'chest' || type === 'trapped_chest' || type === 'barrel') {
          await runSkill(agent.bot, lines, () => skills.viewChest(agent.bot), '打开看了里面的东西', '打开失败');
          return renderReport(lines);
        }
        if (type === 'bed') {
          await runSkill(agent.bot, lines, () => skills.goToBed(agent.bot), '睡下了', '睡不了（不是夜晚，或旁边有怪）');
          return renderReport(lines);
        }

        if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') {

          // **打开熔炉要看得到槽里的东西**。模型真机报过"furnace 打开时不像箱子那样列内容"——

          // 她怀疑炉子里有残留物占着输入槽（这正是"加了煤却烧不了铁"的原因），但看不到，

          // 只能靠反复试各种写法去猜。箱子能列内容，炉子没理由不能。

          if (located == null) return renderReport(lines, '定位不到熔炉。');

          try {

            // **blockAt 可能返回 null**（那一格没加载/读不到），直接传给 openContainer 会
            // 抛 mineflayer 的 'containerToOpen is neither a block nor an entity'——模型真机
            // 报过这条：两条路径都打不开炉子。先自己判空，报一句人话。
            const furnaceBlock = agent.bot.blockAt?.(new Vec3(located.x, located.y, located.z));
            if (furnaceBlock == null) {
              lines.push(step(`读不到 (${located.x},${located.y},${located.z}) 那一格——区块可能没加载，或者坐标偏了。`));
              return renderReport(lines);
            }
            const container: any = await agent.bot.openContainer(furnaceBlock);

            lines.push(step('打开看了炉子里面'));

            lines.push('    ' + slotLine(container.inputItem?.(), '原料槽'));

            lines.push('    ' + slotLine(container.fuelItem?.(), '燃料槽'));

            lines.push('    ' + slotLine(container.outputItem?.(), '产物槽'));

            lines.push('    （想清空某一槽就用 useBlock(type=furnace, output="…") 把东西取出来）');

            await container.close?.();

            return renderReport(lines);

          } catch (error: unknown) {

            lines.push(step('打开熔炉失败：' + (error instanceof Error ? error.message : String(error))));

            return renderReport(lines);

          }

        }
        lines.push(step(`直接用了 ${type}（没有 input/output，所以不改变它的内容）`));
        return renderReport(lines);
      }

      if (plan.kind === 'deposit') {
        if (located == null) return renderReport(lines, '定位不到容器。');
        for (const item of parsedIn.items) {
          const result = await transferWithContainer(agent.bot, located, item.name, item.count, 'deposit');
          lines.push(step(result.ok ? `放入 ${item.name}×${item.count}` : `放入 ${item.name} 失败`));
          lines.push(`    ${result.detail}`);
        }
        return renderReport(lines);
      }

      if (plan.kind === 'withdraw') {
        if (located == null) return renderReport(lines, '定位不到容器。');
        for (const item of parsedOut.items) {
          const result = await transferWithContainer(agent.bot, located, item.name, item.count, 'withdraw');
          lines.push(step(result.ok ? `取出 ${item.name}×${item.count}` : `取出 ${item.name} 失败`));
          lines.push(`    ${result.detail}`);
        }
        return renderReport(lines);
      }

      // process：output 是断言。
      const wanted = parsedOut.items[0];
      if (wanted == null) return renderReport(lines, 'useBlock 用不了：加工要给出 output。');
      if (type === 'furnace' || type === 'blast_furnace' || type === 'smoker') {
        // **`smeltItem` 要的是原料，不是产物**——它自己去查"这个能不能烧"。
        // 真机上模型报过 `Cannot smelt iron_ingot`：我当时把 `output` 当输入传了，
        // 等于问"铁锭能不能烧"。所以烧的是 input，output 只当断言用。
        const raw = parsedIn.items[0];
        if (raw == null) {
          return renderReport(
            lines,
            '烧东西要给出 **input（原料）**：useBlock(type=furnace, input="1 raw_iron", output="1 iron_ingot")。' +
              '燃料不用你操心，熔炉会自己从背包里找煤/木炭/木头。',
          );
        }
        const ok = await runSkill(
          agent.bot,
          lines,
          () => skills.smeltItem(agent.bot, raw.name, raw.count),
          `已点火，开始烧 ${raw.name}×${raw.count}`,
          `烧不了 ${raw.name}`,
        );
        // **不阻塞**：只把估计时间写进返回，取成品是另一次 useBlock（output 单独给）。
        // **失败时不写这句**——模型反馈过它很误导（"failed 还附 10 秒后来取"）。
        if (!ok) {
          return renderReport(lines, '上面那几行是熔炉自己报的原因；照着改（缺燃料就带煤/木炭，炉子里有别的东西就先取出来）。');
        }
        const expected = parsedOut.items[0];
        return renderReport(
          lines,
          `熔炉是异步的：约 10 秒一件，到点了再用 useBlock(type=furnace, output="${expected?.name ?? raw.name}") 来取。`,
        );
      }
      // 工作台 / 铁砧
      const have = countInInventory(agent.bot, wanted.name);
      const crafted = await runSkill(
        agent.bot,
        lines,
        () => skills.craftRecipe(agent.bot, wanted.name, wanted.count),
        `产出 ${wanted.name}×${wanted.count}`,
        `做不出 ${wanted.name}`,
      );
      if (crafted) return renderReport(lines);
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
          `先 craftable 看一眼这个物品的配方和所需材料；只有 3×3 的配方才需要工作台（那时用 useBlock(type=crafting_table, …)）。` +
          (have != null ? `背包里现有 ${want.name}×${have}。` : ''),
      );
    },
  },
];

export default { interactList, planUseBlock, parseItems };
