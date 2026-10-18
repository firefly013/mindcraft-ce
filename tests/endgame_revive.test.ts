/**
 * `reviveDragon` 的测试：**把已经打完的世界变回能打的 Boss 战**。
 *
 * 背景：这个世界 `DragonFight.DragonKilled=1` —— 正常流程直接走到 `done`，
 * 拆水晶/床炸那段代码在真机上永远跑不到。原版给的唯一回头路是"往返回门基座环上的
 * 四个缺口各放一颗末影水晶"。这个文件钉四件事：
 *
 * 1. **四个缺口必须从真实方块推**（不写死 (0,62,0)）：用 Lead 解码的那个结构当
 *    验收 fixture，再换一个**不在原点**的门验证算法没有写死坐标；
 * 2. **放置必须复验**：1.20 里末影水晶是**实体**（minecraft-data 没有 `end_crystal`
 *    这个方块），所以只查方块名会永远判失败、白烧四颗水晶；
 * 3. **失败要停手**：缺口被占 / 放不成 / 龙没回来，都不许继续烧剩下的水晶；
 * 4. **endFightStatus 给两扇门**：走（出口传送门）或者再打一次（4 颗末影水晶）。
 *
 * 不连服务端、不烧 token：纯逻辑 + 假 bot。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toolNames } from '../src/body/commands/registry.js';
import {
    CARDINAL_DIRECTIONS,
    DRAGON_REVIVE_CRYSTALS,
    nextEndgameStep,
    planDragonReviveSpots,
    vec,
    type Vec3,
} from '../src/body/library/endgame.js';

vi.mock('../src/body/library/world.js', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        getNearestBlock: vi.fn(() => null),
        getNearestBlocks: vi.fn(() => []),
        getNearestBlocksWhere: vi.fn(() => []),
    };
});

vi.mock('../src/body/library/skills.js', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        goToPosition: vi.fn(() => Promise.resolve(true)),
        moveAway: vi.fn(() => Promise.resolve(true)),
        placeBlock: vi.fn(() => Promise.resolve(true)),
    };
});

import * as skills from '../src/body/library/skills.js';
import * as world from '../src/body/library/world.js';
import { endgameStatusReport, reviveDragon, verifyReviveCrystalAt } from '../src/body/library/endgame_routine.js';

const CATALOG = new Set(toolNames());

// ============================ 假世界：Lead 解码的返回门结构 ============================

const key = (p: Vec3): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

/**
 * 按 Lead 从存档里解出来的形状造一个返回门：
 * - `y = center.y - 1`：5×5 去掉四个角 = 21 格基座；
 * - `y = center.y`：同一形状，但四个正方向 r=2 的格子是**缺口**（空气）；
 * - `y = center.y + 1..3`：中心 1×1 基座柱（蛋柱）；
 * - 其余全是空气。
 */
function makePortalWorld(
    center: Vec3,
    options: { fill?: Partial<Record<'north' | 'east' | 'south' | 'west', string>> } = {}
): { probe: (p: Vec3) => string | null; blocks: Map<string, string> } {
    const blocks = new Map<string, string>();
    const cx = Math.floor(center.x);
    const cy = Math.floor(center.y);
    const cz = Math.floor(center.z);
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // 四个角没有
            blocks.set(key(vec(cx + dx, cy - 1, cz + dz)), 'bedrock'); // 基座
            blocks.set(key(vec(cx + dx, cy, cz + dz)), 'bedrock'); // 环（缺口稍后覆盖）
        }
    }
    for (let dy = 1; dy <= 3; dy++) blocks.set(key(vec(cx, cy + dy, cz)), 'bedrock'); // 蛋柱
    for (const dir of CARDINAL_DIRECTIONS) {
        const gap = vec(cx + dir.dx * 2, cy, cz + dir.dz * 2);
        blocks.set(key(gap), 'air');
        const fill = options.fill?.[dir.point];
        if (fill != null) blocks.set(key(gap), fill);
    }
    return { probe: (p: Vec3) => blocks.get(key(p)) ?? 'air', blocks };
}

describe('四个缺口：从真实方块推，不写死 (0,62,0)', () => {
    it('Lead 解码的结构（中心 0,62,0）→ 正好四颗，在 ±2 的四个正方向', () => {
        const { probe } = makePortalWorld(vec(0, 62, 0));
        const plan = planDragonReviveSpots({ center: vec(0, 62, 0), probe });
        expect(plan.ok).toBe(true);
        expect(plan.spots).toHaveLength(DRAGON_REVIVE_CRYSTALS);
        const asText = plan.spots.map((s) => `(${s.x},${s.y},${s.z})`).sort();
        expect(asText).toEqual(['(-2,62,0)', '(0,62,-2)', '(0,62,2)', '(2,62,0)'].sort());
        expect(plan.missing).toHaveLength(0);
    });

    it('**环上方那一层不算缺口**（(±1,y+1,0) 也是空气+底下基座，但两侧不是环）', () => {
        const { probe } = makePortalWorld(vec(0, 62, 0));
        const plan = planDragonReviveSpots({ center: vec(0, 62, 0), probe });
        for (const spot of plan.spots) {
            expect(spot.y, '水晶必须放在环那一层').toBe(62);
            expect(Math.abs(spot.x) + Math.abs(spot.z), '必须在 r=2 的缺口上').toBe(2);
        }
    });

    it('门不在原点（中心 100,49,-33）→ 同样推出四个缺口', () => {
        const { probe } = makePortalWorld(vec(100, 49, -33));
        const plan = planDragonReviveSpots({ center: vec(100, 49, -33), probe });
        expect(plan.ok).toBe(true);
        const asText = plan.spots.map((s) => `(${s.x},${s.y},${s.z})`).sort();
        expect(asText).toEqual(['(100,49,-31)', '(100,49,-35)', '(102,49,-33)', '(98,49,-33)'].sort());
    });

    it('中心 y 有观测误差（±1/±2）也能推出来，差 3 格就不行', () => {
        const { probe } = makePortalWorld(vec(100, 49, -33));
        expect(planDragonReviveSpots({ center: vec(100, 50, -33), probe }).ok).toBe(true);
        expect(planDragonReviveSpots({ center: vec(100, 47, -33), probe }).ok).toBe(true);
        expect(planDragonReviveSpots({ center: vec(100, 52, -33), probe }).ok).toBe(false);
    });

    it('某个缺口被方块堵住 → 只找到 3 个，**如实报是哪个方向、被什么占着**', () => {
        const { probe } = makePortalWorld(vec(0, 62, 0), { fill: { east: 'cobblestone' } });
        const plan = planDragonReviveSpots({ center: vec(0, 62, 0), probe });
        expect(plan.ok).toBe(false);
        expect(plan.spots).toHaveLength(3);
        expect(plan.missing).toEqual(['east']);
        expect(plan.blocked[0]?.direction).toBe('east');
        expect(plan.blocked[0]?.block).toBe('cobblestone');
        expect(plan.reason).toContain('东(+X)');
        expect(plan.reason).toContain('cobblestone');
    });

    it('读不到方块（区块没加载）→ 不猜：一个缺口都不给', () => {
        const plan = planDragonReviveSpots({ center: vec(0, 62, 0), probe: () => null });
        expect(plan.ok).toBe(false);
        expect(plan.spots).toHaveLength(0);
    });

    it('缺口下面不是基座（比如悬空）→ 不算缺口', () => {
        const blocks = new Map<string, string>();
        blocks.set('2,62,0', 'air'); // 只有空格，底下没基座
        const plan = planDragonReviveSpots({ center: vec(0, 62, 0), probe: (p) => blocks.get(key(p)) ?? 'air' });
        expect(plan.ok).toBe(false);
        expect(plan.missing).toContain('east');
    });
});

// ============================ 假 bot + 假技能：真的走一遍放置流程 ============================

function makeFakeBot(options: {
    dimension?: string;
    stacks?: Array<{ name: string; count: number }>;
    entities?: Record<string, any>;
    blocks?: Map<string, string>;
} = {}) {
    const stacks = options.stacks ?? [];
    const entities: Record<string, any> = options.entities ?? {};
    const blocks = options.blocks ?? new Map<string, string>();
    return {
        game: { dimension: options.dimension ?? 'the_end' },
        entity: { position: { x: 0, y: 64, z: 0, offset: (dx: number, dy: number, dz: number) => ({ x: dx, y: 64 + dy, z: dz }) } },
        entities,
        registry: { effects: {} },
        health: 20,
        food: 20,
        output: '',
        inventory: { slots: stacks, items: () => stacks },
        blockAt: (p: any) => {
            const name = blocks.get(key(vec(p.x, p.y, p.z)));
            return name == null ? null : { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        },
    };
}

const crystalStack = (count = 4) => ({ name: 'end_crystal', count });

describe('reviveDragon：拒绝路径（一个水晶都不许烧）', () => {
    afterEach(() => {
        vi.mocked(world.getNearestBlock).mockReturnValue(null);
        vi.mocked(skills.placeBlock).mockClear();
    });

    it('不在末地 → 拒绝', async () => {
        const bot = makeFakeBot({ dimension: 'overworld', stacks: [crystalStack()] });
        await expect(reviveDragon(bot)).resolves.toContain('不在末地');
    });

    it('龙还活着 → 拒绝（不用复活）', async () => {
        const bot = makeFakeBot({
            stacks: [crystalStack()],
            entities: { 1: { name: 'ender_dragon', position: { x: 0, y: 70, z: 0 } } },
        });
        await expect(reviveDragon(bot)).resolves.toContain('还活着');
    });

    it('水晶不够 → 说清还差几颗 + 采购清单，且一个方块都不放', async () => {
        const bot = makeFakeBot({ stacks: [{ name: 'end_crystal', count: 2 }] });
        const receipt = await reviveDragon(bot);
        expect(receipt).toContain('还差 2 颗');
        expect(receipt).toContain('恶魂之泪');
        expect(receipt).toContain('末影珍珠');
        expect(receipt).toContain('玻璃');
        expect(vi.mocked(skills.placeBlock)).not.toHaveBeenCalled();
    });

    it('找不到返回门 → 说清找不到什么，不放水晶', async () => {
        const bot = makeFakeBot({ stacks: [crystalStack()] });
        const receipt = await reviveDragon(bot);
        expect(receipt).toContain('找不到返回门');
        expect(vi.mocked(skills.placeBlock)).not.toHaveBeenCalled();
    });

    it('缺口被占 → 停手，一颗都不放（先清障）', async () => {
        const { probe, blocks } = makePortalWorld(vec(0, 62, 0), { fill: { north: 'cobblestone' } });
        vi.mocked(world.getNearestBlock).mockReturnValue({ name: 'end_portal', position: { x: 0, y: 62, z: 0 } });
        const bot = makeFakeBot({ stacks: [crystalStack()] });
        bot.blockAt = (p: any) => {
            const name = probe(vec(p.x, p.y, p.z));
            return name == null ? null : { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        };
        void blocks;
        const receipt = await reviveDragon(bot);
        expect(receipt).toContain('缺口不齐');
        expect(receipt).toContain('北(-Z)');
        expect(vi.mocked(skills.placeBlock)).not.toHaveBeenCalled();
    });
});

describe('reviveDragon：放置复验与复活确认', () => {
    afterEach(() => {
        vi.mocked(world.getNearestBlock).mockReturnValue(null);
        vi.mocked(skills.placeBlock).mockReset();
        vi.mocked(skills.placeBlock).mockImplementation(() => Promise.resolve(true));
    });

    /** 假技能：放一颗就多一颗末影水晶**实体**（1.20 里它不是方块）。 */
    function armPlacement(bot: any, options: { register?: boolean; reviveAfter?: number } = {}) {
        const placed: Array<[string, number, number, number]> = [];
        vi.mocked(skills.placeBlock).mockImplementation((target: any, item: string, x: number, y: number, z: number) => {
            placed.push([item, x, y, z]);
            if (options.register !== false) {
                const id = String(1000 + placed.length);
                target.entities[id] = { name: 'end_crystal', position: { x: x + 0.5, y, z: z + 0.5 } };
            }
            if (options.reviveAfter != null && placed.length >= options.reviveAfter) {
                target.entities['dragon'] = { name: 'ender_dragon', position: { x: 0, y: 70, z: 0 } };
            }
            return Promise.resolve(true);
        });
        void bot;
        return placed;
    }

    it('四颗依次放上、放一颗验一颗，龙回来后如实报（并提示柱子上 10 颗水晶也回来了）', async () => {
        const { probe } = makePortalWorld(vec(0, 62, 0));
        vi.mocked(world.getNearestBlock).mockReturnValue({ name: 'end_portal', position: { x: 0, y: 62, z: 0 } });
        const bot = makeFakeBot({ stacks: [crystalStack(4)] });
        bot.blockAt = (p: any) => {
            const name = probe(vec(p.x, p.y, p.z));
            return name == null ? null : { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        };
        const placed = armPlacement(bot, { reviveAfter: 4 });

        const receipt = await reviveDragon(bot, undefined, { waitMs: 200 });
        expect(placed.map((p) => p[0])).toEqual(['end_crystal', 'end_crystal', 'end_crystal', 'end_crystal']);
        // 放的是推出来的那四个缺口，不是写死的坐标
        expect(placed.map((p) => `${p[1]},${p[2]},${p[3]}`).sort()).toEqual(
            ['-2,62,0', '0,62,-2', '0,62,2', '2,62,0'].sort()
        );
        expect(receipt).toContain('末影龙回来了');
        expect(receipt).toContain('10 颗水晶');
    });

    it('放第四颗之前龙没回来 → **如实说没回来**，不假装成功', async () => {
        const { probe } = makePortalWorld(vec(0, 62, 0));
        vi.mocked(world.getNearestBlock).mockReturnValue({ name: 'end_portal', position: { x: 0, y: 62, z: 0 } });
        const bot = makeFakeBot({ stacks: [crystalStack(4)] });
        bot.blockAt = (p: any) => {
            const name = probe(vec(p.x, p.y, p.z));
            return name == null ? null : { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        };
        armPlacement(bot, {}); // 水晶都放上，但龙不出现

        const receipt = await reviveDragon(bot, undefined, { waitMs: 300, pollMs: 60 });
        expect(receipt).toContain('没看到龙回来');
        expect(vi.mocked(skills.placeBlock)).toHaveBeenCalledTimes(4);
    });

    it('placement 报成功但那一格没长出水晶 → 停手，**不烧剩下三颗**', async () => {
        const { probe } = makePortalWorld(vec(0, 62, 0));
        vi.mocked(world.getNearestBlock).mockReturnValue({ name: 'end_portal', position: { x: 0, y: 62, z: 0 } });
        const bot = makeFakeBot({ stacks: [crystalStack(4)] });
        bot.blockAt = (p: any) => {
            const name = probe(vec(p.x, p.y, p.z));
            return name == null ? null : { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        };
        armPlacement(bot, { register: false }); // 服务端没采纳：不产生实体

        const receipt = await reviveDragon(bot, undefined, { waitMs: 100 });
        expect(receipt).toContain('没有出现新的末影水晶');
        expect(vi.mocked(skills.placeBlock)).toHaveBeenCalledTimes(1); // 只试了一颗
        expect(receipt).toContain('剩下的水晶没动');
    });

    it('放第二颗时那一格被堵上 → 停手并报出是哪一格', async () => {
        const world2 = makePortalWorld(vec(0, 62, 0));
        vi.mocked(world.getNearestBlock).mockReturnValue({ name: 'end_portal', position: { x: 0, y: 62, z: 0 } });
        const bot = makeFakeBot({ stacks: [crystalStack(4)] });
        bot.blockAt = (p: any) => {
            const name = world2.probe(vec(p.x, p.y, p.z));
            return name == null ? null : { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        };
        let placements = 0;
        vi.mocked(skills.placeBlock).mockImplementation((target: any, _item: string, x: number, y: number, z: number) => {
            placements += 1;
            target.entities[String(2000 + placements)] = { name: 'end_crystal', position: { x: x + 0.5, y, z: z + 0.5 } };
            // 第二颗之前，把西边的缺口堵上
            if (placements === 1) world2.blocks.set('-2,62,0', 'cobblestone');
            return Promise.resolve(true);
        });

        const receipt = await reviveDragon(bot);
        expect(placements).toBe(1); // 第二颗没放
        expect(receipt).toContain('停手');
        expect(receipt).toContain('-2,62,0');
    });
});

describe('verifyReviveCrystalAt：末影水晶是**实体**，不是方块', () => {
    it('附近多了一颗新水晶 → 有证据；没有 → null（不能当放上了）', () => {
        const cell = vec(2, 62, 0);
        const bot = makeFakeBot({
            entities: {
                7: { name: 'end_crystal', position: { x: 2.5, y: 62, z: 0.5 } },
            },
        });
        expect(verifyReviveCrystalAt(bot, cell, new Set(['7']))).toContain('已存在');
        expect(verifyReviveCrystalAt(bot, cell, new Set())).toContain('新出现');
        expect(verifyReviveCrystalAt(makeFakeBot({}), cell, new Set())).toBeNull();
    });

    it('远处的水晶不算（柱子上那 10 颗不能被当成新放的）', () => {
        const bot = makeFakeBot({
            entities: { 9: { name: 'end_crystal', position: { x: 40, y: 90, z: 0 } } },
        });
        expect(verifyReviveCrystalAt(bot, vec(2, 62, 0), new Set())).toBeNull();
    });
});

// ============================ endFightStatus / 状态机：两扇门 ============================

describe('龙已经死了：状态机给两扇门', () => {
    const done = { gearReady: true, inEnd: true, crystalsAlive: 0, dragonHealth: 0, dragonAlive: false } as const;

    it('在末地 + 有 4 颗水晶 → 建议 reviveDragon，并把两个选择都写出来', () => {
        const advice = nextEndgameStep({ ...done, endCrystals: 4 });
        expect(advice.phase).toBe('done');
        expect(advice.tool).toBe('reviveDragon');
        expect(CATALOG.has(advice.tool as string)).toBe(true);
        expect(advice.action).toContain('出口传送门'); // 第一扇门：回家
        expect(advice.action).toContain('四个缺口'); // 第二扇门：再打一次
        expect(advice.action).toContain('你现在有 4 个末影水晶');
    });

    it('在末地 + 水晶不够 → 给出采购清单（4 恶魂之泪 + 4 末影之眼 + 玻璃）', () => {
        const advice = nextEndgameStep({ ...done, endCrystals: 0 });
        expect(advice.tool).toBe('craft');
        expect(advice.action).toContain('恶魂之泪');
        expect(advice.action).toContain('末影之眼');
        expect(advice.action).toContain('玻璃');
        expect(advice.action).toContain('你现在有 0 个末影水晶');
    });

    it('不在末地 → 直接进 done 分支时也给出"回末地再复活"的说法', () => {
        // 注意：`inEnd !== true` 时状态机会先走主世界那段（找要塞/进门），
        // 所以这里显式带上"门已经激活"的标记，才落到 done 分支。
        const advice = nextEndgameStep({ ...done, inEnd: false, strongholdFound: true, portalActivated: true, endCrystals: 4 });
        expect(advice.phase).toBe('enter_end');
        expect(advice.tool).toBe('enterEnd');
    });

    it('龙状态失同步那条分支保留：先复核再走', () => {
        const advice = nextEndgameStep({ ...done, dragonHealth: null });
        expect(advice.phase).toBe('done');
        expect(advice.reason).toContain('复核');
    });

    it('建议的工具都在工具表里', () => {
        for (const state of [{ ...done, endCrystals: 4 }, { ...done, endCrystals: 0 }, { ...done, inEnd: false }]) {
            const advice = nextEndgameStep(state);
            if (advice.tool != null) expect(CATALOG.has(advice.tool), `${advice.tool}`).toBe(true);
        }
    });
});

describe('endFightStatus 报告：花水晶之前先看到"门上有几个缺口"', () => {
    function makeReportBot(options: { crystals?: number } = {}) {
        const { probe } = makePortalWorld(vec(0, 62, 0));
        const stacks = [
            { name: 'obsidian', count: 64 },
            { name: 'bow', count: 1 },
            { name: 'arrow', count: 32 },
        ];
        if ((options.crystals ?? 0) > 0) stacks.push({ name: 'end_crystal', count: options.crystals as number });
        const bot = makeFakeBot({ stacks });
        bot.blockAt = (p: any) => {
            const name = probe(vec(p.x, p.y, p.z));
            return name == null ? null : { name, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        };
        vi.mocked(world.getNearestBlock).mockImplementation((_bot: any, name: any) =>
            name === 'end_portal' ? { name: 'end_portal', position: { x: 0, y: 62, z: 0 } } : null
        );
        return bot;
    }

    afterEach(() => {
        vi.mocked(world.getNearestBlock).mockReturnValue(null);
    });

    it('龙已死 + 缺口齐 + 水晶不够 → 报告写清"4 个缺口可用"和差哪些材料', () => {
        const report = endgameStatusReport(makeReportBot({ crystals: 1 }));
        expect(report).toContain('【复活龙】');
        expect(report).toContain('门上有 4 个缺口可用');
        expect(report).toContain('末影水晶 1/4');
        expect(report).toContain('还差 3 颗');
        expect(report).toContain('恶魂之泪');
    });

    it('水晶够了 → 报告直接说"调 reviveDragon 就能把龙叫回来"', () => {
        const report = endgameStatusReport(makeReportBot({ crystals: 4 }));
        expect(report).toContain('末影水晶 4/4');
        expect(report).toContain('reviveDragon');
    });

    it('记过主世界传送门坐标 → 报告不再让人去掷眼找要塞（门是激活过的）', () => {
        vi.mocked(world.getNearestBlock).mockReturnValue(null);
        const bot = makeFakeBot({
            dimension: 'overworld',
            stacks: [
                { name: 'obsidian', count: 64 },
                { name: 'bow', count: 1 },
                { name: 'arrow', count: 32 },
                // 眼的材料齐了，这样"没记过门"的那一份才会走到 travel_stronghold
                { name: 'blaze_rod', count: 7 },
                { name: 'ender_pearl', count: 12 },
                { name: 'ender_eye', count: 12 },
            ],
        });
        const withPortal = endgameStatusReport(bot, {
            memory_bank: { recallPlace: (name: string) => (name === 'overworld_end_portal' ? [63, 64, 34] : undefined) },
        });
        expect(withPortal).not.toContain('travel_stronghold');
        expect(withPortal).toContain('enter_end');

        const withoutPortal = endgameStatusReport(bot, { memory_bank: { recallPlace: () => undefined } });
        expect(withoutPortal).toContain('travel_stronghold');
    });

    it('门已激活时不再让人回下界刷烈焰棒（眼只有"填门"一个用途）', () => {
        vi.mocked(world.getNearestBlock).mockReturnValue(null);
        const bot = makeFakeBot({
            dimension: 'overworld',
            stacks: [
                { name: 'obsidian', count: 64 },
                { name: 'bow', count: 1 },
                { name: 'arrow', count: 32 },
            ],
        });
        const report = endgameStatusReport(bot, {
            memory_bank: { recallPlace: (name: string) => (name === 'overworld_end_portal' ? [63, 64, 34] : undefined) },
        });
        expect(report).not.toContain('nether_fortress');
    });

    it('找不到门 → 报告说清找不到，不许瞎指位置', () => {
        vi.mocked(world.getNearestBlock).mockReturnValue(null);
        const bot = makeFakeBot({ stacks: [{ name: 'end_crystal', count: 4 }] });
        const report = endgameStatusReport(bot);
        expect(report).toContain('【复活龙】找不到返回门');
    });
});
