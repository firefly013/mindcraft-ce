/**
 * `searchWiki` 的离线兜底。
 *
 * 真机缺陷（overnight_a 的模型反馈）：`searchWiki 连「弓」这种最基础的东西都报 not found`。
 * 根因不是数据，是**工具在这台机器上永远不可能成功**：`https://minecraft.wiki/w/Bow`
 * 从这里访问返回 **HTTP 403**（带正常浏览器 UA/Accept 也照样 403），而 example.com 是 200。
 *
 * 于是要求变成：网络失败（403/404/超时/空正文）时，用 minecraft-data 回答
 * "这是什么 / 怎么做 / 要多少"，并且**明确标注不是 wiki 原文**；两边都没有就如实说，
 * 并指向离线可用的工具。**任何失败都不许把错误页文字当知识返回。**
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryList } from '../src/body/commands/queries.js';
import { LOCAL_WIKI_LABEL, matchWikiName, renderLocalWikiAnswer } from '../src/shared/wiki_local.js';
import type { AgentCommand } from '../src/body/commands/actions.js';

const searchWiki = queryList.find((c) => c.name === '!searchWiki') as AgentCommand;

/** 每个用例后都恢复真 fetch，避免互相污染。 */
const realFetch = globalThis.fetch;
afterEach(() => {
  vi.stubGlobal('fetch', realFetch);
  vi.restoreAllMocks();
});

function stubStatus(status: number, body = ''): void {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) }),
  );
}

describe('matchWikiName：从自然语言里认出真实存在的名字', () => {
  const names = ['bow', 'oak_planks', 'crafting_table', 'torch', 'stick', 'string', 'obsidian'];

  it('精确匹配（大小写/空格/minecraft: 前缀都不影响）', () => {
    expect(matchWikiName('bow', names)).toBe('bow');
    expect(matchWikiName('  Bow ', names)).toBe('bow');
    expect(matchWikiName('minecraft:bow', names)).toBe('bow');
  });

  it('能从问句里挑出名字（模型的真实提问就是这样）', () => {
    expect(matchWikiName('how do I craft a bow', names)).toBe('bow');
    expect(matchWikiName('what is a crafting table', names)).toBe('crafting_table');
    expect(matchWikiName('oak planks', names)).toBe('oak_planks');
  });

  it('认不出来就返回 null——不许猜', () => {
    expect(matchWikiName('definitely not a real item', names)).toBeNull();
    expect(matchWikiName('', names)).toBeNull();
    expect(matchWikiName('bow', [])).toBeNull();
  });
});

describe('renderLocalWikiAnswer：本地答案的形状', () => {
  it('带"本地资料/不是 wiki 原文"标签，并把配方写成"材料 → 产出（工作台）"', () => {
    const text = renderLocalWikiAnswer({
      query: 'bow',
      name: 'bow',
      item: { displayName: 'Bow', stackSize: 1, maxDurability: 1 },
      block: null,
      recipes: [[{ stick: 3, string: 3 }, { craftedCount: 1 }]],
      displayName: (n) => ({ stick: 'Stick', string: 'String' })[n] ?? n,
      why: 'wiki 拒绝了这次查询（HTTP 403，这台机器被挡了）',
    });
    expect(text).toContain(LOCAL_WIKI_LABEL);
    expect(text).toContain('403');
    expect(text).toContain('3 个 Stick（stick） + 3 个 String（string） → 1 个 Bow（工作台）');
    expect(text).toContain('getCraftingPlan(targetItem=bow');
    // 占位耐久（bow 的 maxDurability=1）不许当事实报出来。
    expect(text).not.toContain('耐久 1');
  });

  it('没有配方时如实说"本地配方表里没有"，不编一个', () => {
    const text = renderLocalWikiAnswer({
      query: 'diamond',
      name: 'diamond',
      item: { displayName: 'Diamond', stackSize: 64 },
      recipes: [],
    });
    expect(text).toContain('本地配方表里没有');
    expect(text).toContain('getCraftingPlan');
  });
});

describe('searchWiki：403 也要给出可行动答答案（本地兜底）', () => {
  it('403 → 弓：本地资料给出配方，且不含任何网页文字', async () => {
    stubStatus(403, '<div class="mw-parser-output">Forbidden</div>');
    const out = (await searchWiki.perform({}, 'bow')) as string;
    expect(out).toContain(LOCAL_WIKI_LABEL);
    expect(out).toContain('403');
    expect(out).toContain('Bow（bow）');
    expect(out).toContain('stick');
    expect(out).toContain('string');
    // 错误页里的字**绝不能**当知识返回。
    expect(out).not.toContain('Forbidden');
  });

  it('403 → 工作台：4 个木板 → 1 个工作台', async () => {
    stubStatus(403);
    const out = (await searchWiki.perform({}, 'crafting_table')) as string;
    expect(out).toContain(LOCAL_WIKI_LABEL);
    expect(out).toContain('crafting_table');
    expect(out).toMatch(/oak_planks|planks/);
  });

  it('403 → 火把：1 个煤 + 1 个木棍 → 4 个火把（产出数量要报对）', async () => {
    stubStatus(403);
    const out = (await searchWiki.perform({}, 'torch')) as string;
    expect(out).toContain(LOCAL_WIKI_LABEL);
    expect(out).toContain('stick');
    expect(out).toContain('4 个 Torch');
  });

  it('404 也走本地兜底（条目名对不上不等于本地没有）', async () => {
    stubStatus(404);
    const out = (await searchWiki.perform({}, 'bow')) as string;
    expect(out).toContain(LOCAL_WIKI_LABEL);
    expect(out).toContain('404');
    expect(out).toContain('Bow（bow）');
  });

  it('网络超时/异常 → 本地兜底（不是"没有信息"）', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('The operation was aborted')));
    const out = (await searchWiki.perform({}, 'obsidian')) as string;
    expect(out).toContain(LOCAL_WIKI_LABEL);
    expect(out).toContain('obsidian');
  });

  it('本地也没有 → 如实说没有，并指向离线可用的工具', async () => {
    stubStatus(403);
    const out = (await searchWiki.perform({}, 'definitely_not_a_page_xyz')) as string;
    expect(out).toContain('本地资料');
    expect(out).toContain('也没有这个名字');
    expect(out).toContain('getCraftingPlan');
    expect(out).toContain('stats');
  });

  it('真拿到页面时原样返回，不加本地标签', async () => {
    stubStatus(200, '<div class="mw-parser-output">Bow is a ranged weapon.</div>');
    const out = (await searchWiki.perform({}, 'bow')) as string;
    expect(out).toContain('Bow is a ranged weapon.');
    expect(out).not.toContain(LOCAL_WIKI_LABEL);
  });

  it('宿主注入的知识源优先于网络（离线部署/单测契约不变）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await searchWiki.perform({ wikiSearch: (q: string) => `entry for ${q}` }, 'diamond');
    expect(out).toBe('entry for diamond');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
