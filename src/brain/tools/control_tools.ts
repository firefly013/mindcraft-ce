/**
 * P4：5 个控制工具里剩下的 3 个（`Finish` / `Say` 已在 `loop.ts`）。
 *
 * 三者的依赖都是**注入**的（`onStop` / `apply` / `deps`），所以本阶段就能完整
 * 单测；等 P5/P6 把 agent 接过来，传入闭包即可，工具定义不用改。
 */
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import {
  appendFeedback,
  buildFeedbackEntry,
  validateFeedback,
} from '../feedback.js';
import type { PlanSnapshot, PlanTodoInput } from '../plan.js';
import { validateUpdatePlan } from './validate.js';
import { td, tp } from '../../shared/prompts.js';
import { outcomeText } from './tools.js';

/** `Stop`：停下一切。旧实现先失效 generation 再停身体，新世界用 `abort()` 一步到位。 */
export function createStopTool(onStop: () => void | Promise<void>): ToolRegistration {
  return defineTool({
    name: 'Stop',
    description: td('Stop'),
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      await onStop();
      // 旧回执是 `{stopped:true, generation:N}`；generation 是旧调度的内部
      // 计数器，新世界没有对应物，保留 stopped 这一项。
      return { content: [{ type: 'text' as const, text: outcomeText({ stopped: true }) }] };
    },
  });
}

/** `UpdatePlan` 的入参类型（`Static` 形状）。 */
export interface UpdatePlanArgs {
  goal?: string;
  todos?: Array<{ text: string; done?: boolean }>;
}

/**
 * 旧格式兼容：`todos: ["砍树"]` → `[{text:'砍树', done:false}]`。
 *
 * pi-durable 的 `prepareArguments` 在校验**之前**运行，正是为这种"模型常见
 * 写法要修"的场景设计的——于是"广告给模型的是严格 schema、执行侧仍兼容旧
 * 格式"两者都保住，不用把 schema 放宽。
 *
 * 多余键**原样透传**，交给 `validateUpdatePlan` 报错，不静默吞掉（与旧行为一致）。
 */
export function normalizeUpdatePlanArguments(args: unknown): UpdatePlanArgs {
  const given = (args ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...given };
  const todos = given['todos'];
  if (Array.isArray(todos)) {
    out['todos'] = todos
      .map((todo): { text: string; done?: boolean } | null => {
        if (typeof todo === 'string') return { text: todo, done: false };
        if (todo == null || typeof todo !== 'object' || Array.isArray(todo)) return null;
        const entry = todo as Record<string, unknown>;
        const text = typeof entry['text'] === 'string' ? entry['text'] : '';
        return typeof entry['done'] === 'boolean' ? { text, done: entry['done'] } : { text };
      })
      .filter((todo): todo is { text: string; done?: boolean } => todo != null);
  }
  return out as UpdatePlanArgs;
}

/** `UpdatePlan`：整单替换模型自己的计划。 */
export function createUpdatePlanTool(
  apply: (goal: string | null | undefined, todos: PlanTodoInput[] | null | undefined) => PlanSnapshot,
): ToolRegistration {
  return defineTool({
    name: 'UpdatePlan',
    description: td('UpdatePlan'),
    parameters: Type.Object(
      {
        goal: Type.Optional(Type.String({ description: tp('UpdatePlan', 'goal') })),
        todos: Type.Optional(
          Type.Array(
            Type.Object(
              {
                text: Type.String({ description: '待办内容。' }),
                done: Type.Optional(Type.Boolean({ description: '是否已完成。' })),
              },
              { additionalProperties: false },
            ),
            { description: tp('UpdatePlan', 'todos') },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    prepareArguments: normalizeUpdatePlanArguments,
    // 全同步逻辑；`execute` 契约要求 Promise，但不该写 async（require-await）。
    execute: (args) => {
      const checked = validateUpdatePlan(args);
      if (!checked.ok) {
        return Promise.resolve({
          content: [
            { type: 'text' as const, text: `rejected: ${checked.errors?.join('; ') ?? 'Bad arguments.'}` },
          ],
          isError: true,
        });
      }
      const given = (args ?? {}) as { goal?: string | null; todos?: PlanTodoInput[] | null };
      const snapshot = apply(given.goal, given.todos);
      const todos =
        snapshot.todos.length > 0
          ? snapshot.todos.map((todo) => `${todo.done ? '[x]' : '[ ]'} ${todo.text}`).join('; ')
          : 'none';
      return Promise.resolve({
        content: [
          { type: 'text' as const, text: `Plan updated. Goal: ${snapshot.goal ?? 'none'}. Todos: ${todos}.` },
        ],
      });
    },
  });
}

/** `Feedback` 的外部依赖（落盘目录、计划快照、历史尾部）。 */
export interface FeedbackDeps {
  /** 落盘目录（旧实现是 `./bots/<name>`）。 */
  dir: () => string;
  /** 计划快照，附进反馈。 */
  plan: () => PlanSnapshot | null;
  /** 历史尾部摘要来源。 */
  historyTail: () => Array<{ role: string; content: string }>;
}

/** `Feedback`：模型提使用意见，写失败必须显式拒绝（不能被悄悄吞掉）。 */
export function createFeedbackTool(deps: FeedbackDeps): ToolRegistration {
  return defineTool({
    name: 'Feedback',
    description: td('Feedback'),
    parameters: Type.Object(
      {
        title: Type.String({ description: tp('Feedback', 'title') }),
        body: Type.String({ description: tp('Feedback', 'body') }),
      },
      { additionalProperties: false },
    ),
    // 全同步逻辑；`execute` 契约要求 Promise，但不该写 async（require-await）。
    execute: (args) => {
      const checked = validateFeedback(args);
      if (!checked.ok) {
        return Promise.resolve({
          content: [
            { type: 'text' as const, text: `rejected: ${checked.errors?.join('; ') ?? 'Bad arguments.'}` },
          ],
          isError: true,
        });
      }
      const given = args as { title: string; body: string };
      const entry = buildFeedbackEntry(
        { title: given.title, body: given.body },
        { plan: deps.plan(), historyTail: deps.historyTail() },
      );
      try {
        const file = appendFeedback(deps.dir(), entry);
        return Promise.resolve({
          content: [{ type: 'text' as const, text: `反馈已记录到 ${file}，谢谢，接着干活。` }],
        });
      } catch (error: unknown) {
        return Promise.resolve({
          content: [
            {
              type: 'text' as const,
              text: `rejected: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        });
      }
    },
  });
}

/**
 * 记住的地点：**真源在大脑侧的会话文档里**（`PlacesDoc`，经 `stateAccess`）。
 *
 * 为什么这三个工具住在大脑侧，而不是跟其他游戏命令一起待在身体侧：
 *
 * - 地点是**知识**（"我把铁矿洞记在 (-40,51,7)"），不是身体动作。身体的职责是
 *   执行动作和采样世界，记住的东西该由大脑持有——它才是跨重启续命的那一层。
 * - 以前它们住在身体侧（`commands/actions.ts` 的 `!rememberHere`），于是身体得
 *   自己存一份；而大脑的 `PlacesDoc` 也有一份。**同一个事实两个真源**，结果就是
 *   模型抱怨的那种现象：存的时候说成功，重启后列不出来（Feedback #6），
 *   以及 "getPlaces 这个工具不存在"（Feedback #5，因为列地名藏在 `stats` 里）。
 *
 * 依赖全部注入，所以这里可以单测。
 */
export interface PlacesDeps {
  /** 读全部地名 → 坐标。 */
  read(): Promise<Record<string, [number, number, number]>>;
  /** 整份写回（调用方负责合并）。 */
  write(places: Record<string, [number, number, number]>): Promise<void>;
  /** 当前位置（脚部坐标）；拿不到返回 null。 */
  here(): Promise<{ x: number; y: number; z: number } | null>;
  /** 走到某处。返回给模型看的回执。 */
  goto(x: number, y: number, z: number): Promise<string>;
}

/** 坐标取整：模型不需要浮点噪音。 */
function roundCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

/** `getPlaces`：列出记住的地名（Feedback #5——模型一直在找这个工具）。 */
export function createGetPlacesTool(deps: PlacesDeps): ToolRegistration {
  return defineTool({
    name: 'getPlaces',
    description: td('getPlaces'),
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const places = await deps.read();
      const entries = Object.entries(places);
      const text =
        entries.length === 0
          ? '（一个都没记住）'
          : entries
              .map(
                ([name, [x, y, z]]) =>
                  `${name}(${roundCoord(x)},${roundCoord(y)},${roundCoord(z)})`,
              )
              .join('、');
      return { content: [{ type: 'text' as const, text }] };
    },
  });
}

/** `rememberHere`：把当前位置记住。**存不下来必须报失败**，不许假报成功。 */
export function createRememberHereTool(deps: PlacesDeps): ToolRegistration {
  return defineTool({
    name: 'rememberHere',
    description: td('rememberHere'),
    parameters: Type.Object({ name: Type.String({ description: tp('rememberHere', 'name') }) }, {
      additionalProperties: false,
    }),
    execute: async (args: unknown) => {
      const given = (args ?? {}) as { name?: unknown };
      const name = typeof given.name === 'string' ? given.name.trim() : '';
      if (name === '') return { content: [{ type: 'text' as const, text: '要给这个地点起个名字。' }] };
      const here = await deps.here();
      if (here == null) {
        return { content: [{ type: 'text' as const, text: 'Location NOT saved: 读不到当前位置。' }] };
      }
      const places = await deps.read();
      places[name] = [here.x, here.y, here.z];
      try {
        await deps.write(places);
      } catch (err: unknown) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Location NOT saved: 写入失败（${err instanceof Error ? err.message : String(err)}）。`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Location saved as "${name}" @(${roundCoord(here.x)},${roundCoord(here.y)},${roundCoord(here.z)})（已存进会话，重启后还在）。`,
          },
        ],
      };
    },
  });
}

/** `goToRememberedPlace`：按地名走回去。 */
export function createGoToRememberedPlaceTool(deps: PlacesDeps): ToolRegistration {
  return defineTool({
    name: 'goToRememberedPlace',
    description: td('goToRememberedPlace'),
    parameters: Type.Object({ name: Type.String({ description: tp('goToRememberedPlace', 'name') }) }, {
      additionalProperties: false,
    }),
    execute: async (args: unknown) => {
      const given = (args ?? {}) as { name?: unknown };
      const name = typeof given.name === 'string' ? given.name.trim() : '';
      if (name === '') return { content: [{ type: 'text' as const, text: '要给出去的地名。' }] };
      const places = await deps.read();
      const at = places[name];
      if (at == null) {
        const known = Object.keys(places);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `No location named "${name}" saved.` +
                (known.length > 0 ? ` 记住过的有：${known.join('、')}。` : ' 而且一个地名都还没记住。'),
            },
          ],
        };
      }
      const text = await deps.goto(at[0], at[1], at[2]);
      return { content: [{ type: 'text' as const, text }] };
    },
  });
}
