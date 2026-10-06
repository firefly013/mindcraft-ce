/**
 * 工具通道归属：动作类占身体通道（忙时拒绝），查询类只读不占，
 * Stop/Finish 是控制信号，不占通道。
 */
import { describe, expect, it, vi } from 'vitest';
import { checkDomain, commandToTool, executeToolCall, isActionTool, stripBang, toolExists, validateToolCall, validateUpdatePlan, formatSay, getOpenAITools, getToolDocs } from '../src/agent/commands/to_openai_tools.js';
import { queryList } from '../src/agent/commands/queries.js';
import type { AgentCommand } from '../src/agent/commands/actions.js';

describe('isActionTool', () => {
  it('action tools claim the body channel', () => {
    expect(isActionTool('goToPlayer')).toBe(true);
    expect(isActionTool('collectBlocks')).toBe(true);
    expect(isActionTool('attack')).toBe(true);
  });

  it('query tools do not claim the channel', () => {
    expect(isActionTool('stats')).toBe(false);
    expect(isActionTool('inventory')).toBe(false);
    expect(isActionTool('entities')).toBe(false);
  });

  it('control tools do not claim the channel', () => {
    expect(isActionTool('Finish')).toBe(false);
    expect(isActionTool('Stop')).toBe(false);
  });

  it('bang prefix is accepted either way', () => {
    expect(isActionTool('!goToPlayer')).toBe(true);
    expect(stripBang('!goToPlayer')).toBe('goToPlayer');
    expect(toolExists('goToPlayer')).toBe(true);
    expect(toolExists('NoSuchTool')).toBe(false);
  });
});

describe('validateToolCall', () => {
  it('accepts a full valid call and control tools', () => {
    expect(validateToolCall('goToPlayer', { player_name: 'steve', closeness: 3 })).toEqual({ ok: true });
    expect(validateToolCall('Finish', {})).toEqual({ ok: true });
    expect(validateToolCall('stats', {})).toEqual({ ok: true });
  });

  it('rejects unknown tools without touching anything else', () => {
    const r = validateToolCall('Fly', {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('UNKNOWN_TOOL');
  });

  it('rejects non-object args', () => {
    expect(validateToolCall('stats', null).code).toBe('BAD_ARGS');
    expect(validateToolCall('stats', 'x').code).toBe('BAD_ARGS');
  });

  it('names missing, mistyped and unknown properties with paths', () => {
    const missing = validateToolCall('goToPlayer', { player_name: 'steve' });
    expect(missing.ok).toBe(false);
    expect(missing.errors?.join(';')).toContain('closeness');

    const mistyped = validateToolCall('goToPlayer', { player_name: 'steve', closeness: 'near' });
    expect(mistyped.ok).toBe(false);
    expect(mistyped.errors?.join(';')).toContain('$.closeness');

    const extra = validateToolCall('stats', { foo: 1 });
    expect(extra.ok).toBe(false);
    expect(extra.errors?.join(';')).toContain('foo');

    const notInt = validateToolCall('stay', { type: 1.5 });
    expect(notInt.ok).toBe(false);
  });

  it('null counts as not given: optional/default may omit, required may not', () => {
    // quantity 有 default，可缺。
    expect(validateToolCall('getCraftingPlan', { targetItem: 'stick' }).ok).toBe(true);
    expect(validateToolCall('getCraftingPlan', { targetItem: 'stick', quantity: null }).ok).toBe(true);
    expect(validateToolCall('getCraftingPlan', { quantity: 2 }).ok).toBe(false);
  });

  it('keeps optional/default params out of the schema required list', () => {
    // schema 的 required 不能比校验器更严：quantity 声明了 optional/default，
    // 却被无条件塞进 required 的话，模型会被迫每次传一个本可省的字段。
    const cmd = queryList.find((c) => c.name === '!getCraftingPlan') as AgentCommand;
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
  it('formatSay rejects empty talk and truncates long lines but keeps full text', () => {
    expect(formatSay('').ok).toBe(false);
    expect(formatSay('   ').ok).toBe(false);
    expect(formatSay(123).ok).toBe(false);
    const short = formatSay('来了');
    expect(short).toEqual({ ok: true, line: '来了', full: '来了' });
    const long = formatSay('x'.repeat(300));
    expect(long.ok).toBe(true);
    expect(Array.from(long.line ?? '').length).toBe(241);
    expect(long.full?.length).toBe(300);
  });

  it('Say is a control tool: known, valid, channel-free', () => {
    expect(toolExists('Say')).toBe(true);
    expect(isActionTool('Say')).toBe(false);
    expect(validateToolCall('Say', { text: 'hi' }).ok).toBe(true);
    const tools = getOpenAITools({ blocked_actions: [] });
    const names = tools.map((t) => t.function.name);
    expect(names).toContain('Say');
    expect(names).toContain('Finish');
    expect(names).toContain('Stop');
    expect(names).toContain('UpdatePlan');
  });

  it('UpdatePlan is a control tool with whole-replace shape', () => {
    expect(toolExists('UpdatePlan')).toBe(true);
    expect(isActionTool('UpdatePlan')).toBe(false);
    expect(validateToolCall('UpdatePlan', { goal: 'build', todos: ['wood'] }).ok).toBe(true);
    expect(validateToolCall('UpdatePlan', {}).ok).toBe(true);
    expect(validateUpdatePlan({ goal: 42 }).ok).toBe(false);
    expect(validateUpdatePlan({ todos: 'wood' }).ok).toBe(false);
    expect(validateUpdatePlan({ todos: ['wood', 7] }).ok).toBe(false);
    expect(validateUpdatePlan({ nope: 1 }).ok).toBe(false);
    const tools = getOpenAITools({ blocked_actions: [] });
    expect(tools.map((t) => t.function.name)).toContain('UpdatePlan');
    const docs = getToolDocs({ blocked_actions: [] });
    for (const name of ['Finish', 'Stop', 'Say', 'UpdatePlan', 'Feedback']) {
      expect(docs).toContain(`${name}:`);
    }
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
    const bad = validateToolCall('goToCoordinates', { x: 0, y: 400, z: 0 });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('BAD_ARGS');
    expect(bad.errors?.join('; ')).toContain('<= 320');
    expect(validateToolCall('goToCoordinates', { x: 0, y: 64, z: 0, closeness: 1 }).ok).toBe(true);
  });

  it('exposes finite domain bounds to the model in the schema', () => {
    const cmd = { name: '!goToCoordinates', description: 'go', params: { y: { type: 'float', domain: [-64, 320] } } };
    const tool = commandToTool(cmd as unknown as AgentCommand);
    expect(tool.function.parameters['properties']).toMatchObject({ y: { minimum: -64, maximum: 320 } });
  });

  it('advertises an exclusive bound as exclusive*, matching what the validator enforces', () => {    // minimum/maximum 是闭语义；开区间必须用 exclusive*，否则 schema 说的区间
    // 比 checkDomain 实际放行的更宽（模型给 0 合法、校验器却拒）。
    const param = { type: 'int', domain: [0, 10, '(]'] } as const;
    const cmd = { name: '!x', description: 'x', params: { n: param } };
    const tool = commandToTool(cmd as unknown as AgentCommand);
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
      expect(out).toContain('no information');
      expect(out).not.toContain('Service Unavailable');
    } finally {
      vi.stubGlobal('fetch', original);
    }
  });

  it('keeps the friendly 404 message for a missing page', async () => {
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }));
    try {
      const out = (await searchWiki.perform({}, 'definitely_not_a_page')) as string;
      expect(out).toContain('was not found on the Minecraft Wiki');
    } finally {
      vi.stubGlobal('fetch', original);
    }
  });
});
