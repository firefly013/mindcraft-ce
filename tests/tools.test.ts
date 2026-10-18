/**
 * 工具通道归属：动作类占身体通道（忙时拒绝），查询类只读不占，
 * Stop/Finish 是控制信号，不占通道。
 */
import { SAY_LINE_LIMIT } from '../src/shared/prompts.js';
import { describe, expect, it, vi } from 'vitest';
import { commandToTool, getOpenAITools } from '../src/brain/tools/advertise.js';
import { createToolCatalog } from '../src/brain/tools/catalog.js';
import { checkDomain, formatSay, isActionTool, toolExists, validateToolCall, validateUpdatePlan } from '../src/brain/tools/validate.js';
import { stripBang } from '../src/shared/tools.js';
import { executeToolCall } from '../src/body/commands/execute.js';
import { toolDeclarations } from '../src/body/commands/registry.js';
import { queryList } from '../src/body/commands/queries.js';
import { LOCAL_WIKI_LABEL } from '../src/shared/wiki_local.js';
import type { AgentCommand } from '../src/body/commands/actions.js';

/** 与生产一致：工具目录来自身体握手报上来的声明。 */
const ALL_TOOLS = toolDeclarations();
const CATALOG = createToolCatalog(ALL_TOOLS);

describe('isActionTool', () => {
  it('action tools claim the body channel', () => {
    expect(isActionTool(CATALOG, 'goToPlayer')).toBe(true);
    expect(isActionTool(CATALOG, 'collectBlocks')).toBe(true);
    expect(isActionTool(CATALOG, 'attack')).toBe(true);
  });

  it('query tools do not claim the channel', () => {
    expect(isActionTool(CATALOG, 'stats')).toBe(false);
    expect(isActionTool(CATALOG, 'getCraftingPlan')).toBe(false);
    expect(isActionTool(CATALOG, 'searchWiki')).toBe(false);
  });

  it('control tools do not claim the channel', () => {
    expect(isActionTool(CATALOG, 'Finish')).toBe(false);
    expect(isActionTool(CATALOG, 'Stop')).toBe(false);
  });

  it('bang prefix is accepted either way', () => {
    expect(isActionTool(CATALOG, '!goToPlayer')).toBe(true);
    expect(stripBang('!goToPlayer')).toBe('goToPlayer');
    expect(toolExists(CATALOG, 'goToPlayer')).toBe(true);
    expect(toolExists(CATALOG, 'NoSuchTool')).toBe(false);
  });
});

describe('validateToolCall', () => {
  it('accepts a full valid call and control tools', () => {
    expect(validateToolCall(CATALOG, 'goToPlayer', { player_name: 'steve', closeness: 3 })).toEqual({ ok: true });
    expect(validateToolCall(CATALOG, 'Finish', {})).toEqual({ ok: true });
    expect(validateToolCall(CATALOG, 'stats', {})).toEqual({ ok: true });
  });

  it('rejects unknown tools without touching anything else', () => {
    const r = validateToolCall(CATALOG, 'Fly', {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_TOOL');
  });

  it('attack 的 type 是必填，不给就拒', () => {
    // target 的含义全靠 type 声明（id/player/mob），没有默认值——
    // 靠字符串形状隐式猜等于把"玩家优先"这个人为约定藏起来。
    // 少一层 optional，schema 的 required 与运行时校验就都能拦住漏填。
    expect(validateToolCall(CATALOG, 'attack', { target: '9' }).ok).toBe(false);
    expect(validateToolCall(CATALOG, 'attack', { target: '9' }).errors?.join(';')).toContain('type');
    expect(validateToolCall(CATALOG, 'attack', { target: '9', type: 'id' })).toEqual({ ok: true });
    expect(validateToolCall(CATALOG, 'attack', { target: 'Notch', type: 'player' })).toEqual({ ok: true });
  });

  it('rejects non-object args', () => {
    expect(validateToolCall(CATALOG, 'stats', null).code).toBe('BAD_ARGS');
    expect(validateToolCall(CATALOG, 'stats', 'x').code).toBe('BAD_ARGS');
  });

  it('names missing, mistyped and unknown properties with paths', () => {
    const missing = validateToolCall(CATALOG, 'goToPlayer', { player_name: 'steve' });
    expect(missing.ok).toBe(false);
    expect(missing.errors?.join(';')).toContain('closeness');

    const mistyped = validateToolCall(CATALOG, 'goToPlayer', { player_name: 'steve', closeness: 'near' });
    expect(mistyped.ok).toBe(false);
    expect(mistyped.errors?.join(';')).toContain('$.closeness');

    const extra = validateToolCall(CATALOG, 'stats', { foo: 1 });
    expect(extra.ok).toBe(false);
    expect(extra.errors?.join(';')).toContain('foo');

    const notInt = validateToolCall(CATALOG, 'stay', { type: 1.5 });
    expect(notInt.ok).toBe(false);
  });

  it('null counts as not given: optional/default may omit, required may not', () => {
    // quantity 有 default，可缺。
    expect(validateToolCall(CATALOG, 'getCraftingPlan', { targetItem: 'stick' }).ok).toBe(true);
    expect(validateToolCall(CATALOG, 'getCraftingPlan', { targetItem: 'stick', quantity: null }).ok).toBe(true);
    expect(validateToolCall(CATALOG, 'getCraftingPlan', { quantity: 2 }).ok).toBe(false);
  });

  it('keeps optional/default params out of the schema required list', () => {
    // schema 的 required 不能比校验器更严：quantity 声明了 optional/default，
    // 却被无条件塞进 required 的话，模型会被迫每次传一个本可省的字段。
    const cmd = ALL_TOOLS.find((d) => d.name === 'getCraftingPlan');
    if (cmd == null) throw new Error('missing declaration');
    const tool = commandToTool(cmd);
    const required = tool.function.parameters['required'] as string[];
    expect(required).toContain('targetItem');
    expect(required).not.toContain('quantity');
  });

  it('normalizes null to undefined so JS default parameters still apply', async () => {
    // 校验器把 null 当"没给"，但 JS 默认参数只对 undefined 生效——不归一的话
    // `{quantity: null}` 会拿到 "Invalid input"，而不是默认的 1。
    // 注意 slots 必须给：少了它 perform 会在读库存时就抛，两个分支变成同一个
    // 错误串，这条断言就白测了。
    const agent = { bot: { inventory: { slots: [], items: () => [] } } };
    const asNull = await executeToolCall(agent, 'getCraftingPlan', { targetItem: 'stick', quantity: null });
    const asOne = await executeToolCall(agent, 'getCraftingPlan', { targetItem: 'stick', quantity: 1 });
    expect(asNull).not.toContain('Invalid input');
    expect(asNull).toBe(asOne);
  });
});

describe('Say isolation', () => {
  it('formatSay rejects empty talk and over-limit lines (不截断，让模型自己缩短)', () => {
    expect(formatSay('').ok).toBe(false);
    expect(formatSay('   ').ok).toBe(false);
    expect(formatSay(123).ok).toBe(false);
    const short = formatSay('来了');
    expect(short).toEqual({ ok: true, line: '来了', full: '来了' });
    // 超限：拒绝，理由里带上超了多少和上限是多少。
    const long = formatSay('x'.repeat(SAY_LINE_LIMIT + 1));
    expect(long.ok).toBe(false);
    expect(long.reason).toContain(String(SAY_LINE_LIMIT + 1));
    expect(long.line).toBeUndefined();
    // 刚好到上限：放行。
    expect(formatSay('x'.repeat(SAY_LINE_LIMIT)).ok).toBe(true);
  });

  it('Say is a control tool: known, valid, channel-free', () => {
    expect(toolExists(CATALOG, 'Say')).toBe(true);
    expect(isActionTool(CATALOG, 'Say')).toBe(false);
    expect(validateToolCall(CATALOG, 'Say', { text: 'hi' }).ok).toBe(true);
    const tools = getOpenAITools(ALL_TOOLS, []);
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('Say');
    expect(names).toContain('Finish');
    expect(names).toContain('Stop');
    expect(names).toContain('UpdatePlan');
  });

  it('UpdatePlan is a control tool with whole-replace shape', () => {
    expect(toolExists(CATALOG, 'UpdatePlan')).toBe(true);
    expect(isActionTool(CATALOG, 'UpdatePlan')).toBe(false);
    expect(validateToolCall(CATALOG, 'UpdatePlan', { goal: 'build', todos: ['wood'] }).ok).toBe(true);
    expect(validateToolCall(CATALOG, 'UpdatePlan', {}).ok).toBe(true);
    expect(validateUpdatePlan({ goal: 42 }).ok).toBe(false);
    expect(validateUpdatePlan({ todos: 'wood' }).ok).toBe(false);
    expect(validateUpdatePlan({ todos: ['wood', 7] }).ok).toBe(false);
    expect(validateUpdatePlan({ nope: 1 }).ok).toBe(false);
    const tools = getOpenAITools(ALL_TOOLS, []);
    expect(tools.map((t) => t.function.name)).toContain('UpdatePlan');
  });
});

describe('checkDomain', () => {
  it('enforces a closed range', () => {
    const y = { type: 'float', domain: [-64, 320] };
    expect(checkDomain(y, 64, '$.y')).toBeNull();
    expect(checkDomain(y, -64, '$.y')).toBeNull();
    expect(checkDomain(y, 320, '$.y')).toBeNull();
    expect(checkDomain(y, 321, '$.y')).toBe('$.y: expected <= 320, got 321');
    expect(checkDomain(y, -65, '$.y')).toBe('$.y: expected >= -64, got -65');
  });

  it('honours exclusive brackets', () => {
    const num = { type: 'int', domain: [1, Infinity, '[)'] };
    expect(checkDomain(num, 1, '$.num')).toBeNull();
    expect(checkDomain(num, 0, '$.num')).toBe('$.num: expected >= 1, got 0');
    const open = { type: 'int', domain: [0, 10, '(]'] };
    expect(checkDomain(open, 0, '$.num')).toBe('$.num: expected > 0, got 0');
    expect(checkDomain(open, 10, '$.num')).toBeNull();
  });

  it('does nothing without a domain', () => {
    expect(checkDomain({ type: 'float' }, 9999, '$.x')).toBeNull();
  });

  it('rejects an out-of-range value through validateToolCall', () => {
    const bad = validateToolCall(CATALOG, 'goToCoordinates', { x: 0, y: 400, z: 0 });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('BAD_ARGS');
    expect(bad.errors?.join('; ')).toContain('<= 320');
    expect(validateToolCall(CATALOG, 'goToCoordinates', { x: 0, y: 64, z: 0, closeness: 1 }).ok).toBe(true);
  });

  it('exposes finite domain bounds to the model in the schema', () => {
    const cmd = { name: 'goToCoordinates', description: 'go', kind: 'action' as const, params: { y: { type: 'float', domain: [-64, 320] } } };
    const tool = commandToTool(cmd);
    expect(tool.function.parameters['properties']).toMatchObject({ y: { minimum: -64, maximum: 320 } });
  });

  it('advertises an exclusive bound as exclusive*, matching what the validator enforces', () => {    // minimum/maximum 是闭语义；开区间必须用 exclusive*，否则 schema 说的区间
    // 比 checkDomain 实际放行的更宽（模型给 0 合法、校验器却拒）。
    const param = { type: 'int', domain: [0, 10, '(]'] } as const;
    const cmd = { name: 'x', description: 'x', kind: 'action' as const, params: { n: param } };
    const tool = commandToTool(cmd);
    const props = tool.function.parameters['properties'] as Record<string, Record<string, unknown>>;
    expect(props['n']?.['exclusiveMinimum']).toBe(0);
    expect(props['n']?.['maximum']).toBe(10);
    expect(props['n']?.['minimum']).toBeUndefined();
    // 与校验器一致：schema 说 0 不合法，checkDomain 也必须拒。
    expect(checkDomain({ type: 'int', domain: [0, 10, '(]'] }, 0, '$.n')).not.toBeNull();
    expect(checkDomain({ type: 'int', domain: [0, 10, '(]'] }, 10, '$.n')).toBeNull();
  });
});

describe('SearchWiki', () => {
  const searchWiki = queryList.find((c) => c.name === '!searchWiki') as AgentCommand;

  it('uses a host-injected corpus when one is provided', async () => {
    const out = await searchWiki.perform({ wikiSearch: (q: string) => `entry for ${q}` }, 'diamond');
    expect(out).toBe('entry for diamond');
  });

  it('says so when the injected corpus has nothing', async () => {
    expect(await searchWiki.perform({ wikiSearch: () => '' }, 'nothing')).toBe('No wiki entry found for "nothing".');
  });

  it('reports an injected failure as no-information, not as an answer', async () => {
    const out = (await searchWiki.perform(
      {
        wikiSearch: () => {
          throw new Error('boom');
        },
      },
      'diamond',
    )) as string;
    expect(out).toContain('failed');
    expect(out).toContain('no information');
  });

  it('reports a non-404 HTTP failure instead of parsing the error page', async () => {
    const original = globalThis.fetch;
    // 错误页里**有**可读内容：不特判就会把 "Service Unavailable" 当知识回给模型。
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve('<div class="mw-parser-output">Service Unavailable</div>'),
      }),
    );
    try {
      const out = (await searchWiki.perform({}, 'diamond')) as string;
      expect(out).toContain('503');
      // 网络失败 → 走**离线兜底**，但必须明说这是本地资料，不是 wiki 原文。
      expect(out).toContain(LOCAL_WIKI_LABEL);
      expect(out).not.toContain('Service Unavailable');
    } finally {
      vi.stubGlobal('fetch', original);
    }
  });

  it('本地资料和网络都答不上来时如实说没有（不编内容）', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }));
    try {
      const out = (await searchWiki.perform({}, 'definitely_not_a_page')) as string;
      expect(out).toContain('404');
      expect(out).toContain('也没有这个名字');
      // 并指向真正离线可用的工具，而不是让模型继续换关键词。
      expect(out).toContain('getCraftingPlan');
    } finally {
      vi.stubGlobal('fetch', original);
    }
  });
});
