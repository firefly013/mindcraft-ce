/**
 * 通用投掷（`throwItem`）的测试：不连服务器、不烧 token。
 *
 * 钉四件事：
 *   1) **三类轨迹不能混**：抛物线类解弹道（低伸、超程如实说"打不到"）、
 *      箭矢类"拉弓→放箭 + 核对箭数"、制导类（末影之眼）**永远不做弹道解算**；
 *   2) **事实核验**：数量没少就是"没扔出去"；没看到实体就如实说没看到；
 *      末影珍珠等坐标跳变（跳了报落点 + 提醒固定 5 点伤害，没跳就说没传送）；
 *   3) **表可校准**：`applyThrowCalibration` 改 v 会改解算角度，reset 回默认；
 *   4) **接线/门禁**：注册成 action + longRunning，参数顺序 = perform 位置参数顺序，
 *      schema 每个参数在 TOOL_TEXT 里都有说明（`scripts/check-prompts.ts` 的同款不变式）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyThrowCalibration,
    planThrowAim,
    resetThrowCalibrations,
    solveBallisticPitch,
    supportedThrowables,
    throwItemSkill,
    throwProfileOf,
    type FlatPosition,
} from '../src/body/library/throwing.js';
import { throwingActionList } from '../src/body/commands/throwing.js';
import { findCommand, toolDeclarations, toolNames } from '../src/body/commands/registry.js';
import { TOOL_TEXT } from '../src/shared/prompts.js';
import { getOpenAITools } from '../src/brain/tools/advertise.js';

interface FakeItem {
    name: string;
    count: number;
}

interface ProjectilePlan {
    name: string;
    id: number;
    from: FlatPosition;
    step: FlatPosition;
    /** 采几次之后消失（模拟落地/碎裂）。 */
    steps: number;
}

/** 假身体：背包、实体表、时钟都可控；投掷由 `onActivate` 模拟服务端行为。 */
function harness(
    options: {
        items?: FakeItem[];
        pos?: FlatPosition;
        yaw?: number;
        health?: number;
        projectile?: ProjectilePlan;
        /** 投掷时服务端做了什么（默认：扣掉 1 个物品 + 生成投掷物）。 */
        onActivate?: (ctx: { items: FakeItem[] }) => void;
        /** 投掷物消失后把玩家传送到这里（末影珍珠）。 */
        teleportTo?: FlatPosition;
    } = {},
) {
    const items: FakeItem[] = (options.items ?? []).map((item) => ({ ...item }));
    const bot: any = {
        interrupt_code: false,
        health: options.health ?? 20,
        entity: { position: { ...(options.pos ?? { x: 0, y: 70, z: 0 }) }, yaw: options.yaw ?? 0 },
        inventory: {
            items: () => items,
            findInventoryItem: (name: string) => items.find((item) => item.name === name && item.count > 0),
        },
    };
    let entities: Record<string, any> = {};
    let clock = 0;
    let activated = 0;
    let deactivated = 0;
    let deactivateAt: number | null = null;
    let equipped: string | null = null;
    let look: { yaw: number; pitch: number } | null = null;
    let stepsLeft = options.projectile?.steps ?? 0;
    let teleported = false;

    const spawn = (): void => {
        const plan = options.projectile;
        if (plan == null) return;
        stepsLeft = plan.steps;
        entities = { [String(plan.id)]: { id: plan.id, name: plan.name, position: { ...plan.from } } };
    };

    const deps = {
        position: () => ({ ...bot.entity.position }),
        yaw: () => bot.entity.yaw,
        countOf: (_b: any, name: string) => items.filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0),
        hasItem: (_b: any, name: string) => items.some((item) => item.name === name && item.count > 0),
        equip: async (_b: any, name: string) => {
            equipped = name;
            bot.heldItem = items.find((item) => item.name === name) ?? null;
            return bot.heldItem != null;
        },
        look: async (_b: any, yaw: number, pitch: number) => {
            look = { yaw, pitch };
        },
        activate: async () => {
            activated += 1;
            if (options.onActivate != null) options.onActivate({ items });
            else {
                const plan = options.projectile;
                const target = plan == null ? items[0] : items.find((item) => item.name !== 'bow');
                if (target != null && target.count > 0) target.count -= 1;
            }
            spawn();
        },
        deactivate: async () => {
            deactivated += 1;
            deactivateAt = clock;
        },
        entities: () => entities,
        health: () => bot.health,
        sleep: async (ms: number) => {
            clock += ms;
            if (options.projectile != null && stepsLeft > 0) {
                stepsLeft -= 1;
                const entity = entities[String(options.projectile.id)];
                if (entity != null) {
                    entity.position = {
                        x: entity.position.x + options.projectile.step.x,
                        y: entity.position.y + options.projectile.step.y,
                        z: entity.position.z + options.projectile.step.z,
                    };
                }
                if (stepsLeft <= 0) {
                    delete entities[String(options.projectile.id)];
                    if (options.teleportTo != null && !teleported) {
                        teleported = true;
                        bot.entity.position = { ...options.teleportTo };
                    }
                }
            }
        },
        now: () => clock,
    };

    return {
        bot,
        deps,
        items,
        count: (name: string) => items.filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0),
        get activated() {
            return activated;
        },
        get deactivated() {
            return deactivated;
        },
        get deactivateAt() {
            return deactivateAt;
        },
        get equipped() {
            return equipped;
        },
        get look() {
            return look;
        },
    };
}

/** 快速档：观测窗口短一点，测试跑得快，同时保留轮询语义。 */
const FAST = { observeMs: 600, pollMs: 100, teleportWaitMs: 600 };

afterEach(() => {
    resetThrowCalibrations();
});

// ─────────────────────────── 一、弹道瞄准（纯函数） ───────────────────────────

describe('抛物线瞄准：闭式低伸解', () => {
    it('60 格平射 → 抬头 ≈26.57°（取低伸解，不是 63.43° 的高抛）', () => {
        const pitch = solveBallisticPitch(60, 0, 1.5, 0.03);
        expect(pitch).not.toBeNull();
        const degrees = (-(pitch as number) * 180) / Math.PI;
        expect(degrees).toBeCloseTo(26.57, 1);
        // 高抛解是 63.43°：必须**没**取它
        expect(degrees).toBeLessThan(45);
    });

    it('目标更高要抬得更高；目标更低可以压低', () => {
        const flat = -(solveBallisticPitch(30, 0, 1.5, 0.03) as number);
        const up = -(solveBallisticPitch(30, 10, 1.5, 0.03) as number);
        const down = -(solveBallisticPitch(30, -10, 1.5, 0.03) as number);
        expect(up).toBeGreaterThan(flat);
        expect(down).toBeLessThan(flat);
    });

    it('超出最大射程（v²/g = 75 格）→ null：调用方如实说"打不到"', () => {
        expect(solveBallisticPitch(74, 0, 1.5, 0.03)).not.toBeNull();
        expect(solveBallisticPitch(80, 0, 1.5, 0.03)).toBeNull();
    });

    it('档案表：三类各自的参数都写清了（抛物线 v/g/阻力、箭矢蓄力、眼睛制导）', () => {
        for (const item of [
            'egg',
            'snowball',
            'ender_pearl',
            'splash_potion',
            'lingering_potion',
            'experience_bottle',
        ]) {
            const profile = throwProfileOf(item);
            expect(profile?.klass, item).toBe('parabolic');
            expect(profile?.velocity, item).toBe(1.5);
            expect(profile?.gravity, item).toBe(0.03);
            expect(profile?.drag, item).toBe(0.99);
        }
        const arrow = throwProfileOf('arrow');
        expect(arrow?.klass).toBe('arrow');
        expect(arrow?.charged).toBe(true);
        expect(arrow?.chargeMs).toBe(1000);
        const eye = throwProfileOf('eye_of_ender');
        expect(eye?.klass).toBe('guided');
        expect(eye?.guided).toBe(true);
        // 别名两代都认
        expect(throwProfileOf('ender_eye')?.item).toBe('eye_of_ender');
        expect(throwProfileOf('xp_bottle')?.item).toBe('experience_bottle');
        expect(throwProfileOf('minecraft:egg')?.item).toBe('egg');
        // 不认识就是 null（由调用方拒绝）
        expect(throwProfileOf('diamond_sword')).toBeNull();
    });

    it('**制导类永远不做弹道解算**：500 格外也返回 guided，而不是"打不到"', () => {
        const eye = throwProfileOf('eye_of_ender');
        expect(eye).not.toBeNull();
        const plan = planThrowAim(eye as any, { x: 0, y: 70, z: 0 }, 0, { x: 0, y: 70, z: 500 });
        // 如果谁把末影之眼塞进抛物线表，这里会变成 kind='unreachable' → 测试红
        expect(plan.kind).toBe('guided');
        if (plan.kind !== 'guided') throw new Error('制导类必须返回 guided');
        expect(plan.pitch).toBe(0);
        // 同样的距离对抛物线类就是"打不到"
        const egg = throwProfileOf('egg');
        expect(planThrowAim(egg as any, { x: 0, y: 70, z: 0 }, 0, { x: 0, y: 70, z: 500 }).kind).toBe('unreachable');
    });

    it('校准：改 v 会改解算角度，reset 回默认', () => {
        const before = solveBallisticPitch(40, 0, 1.5, 0.03);
        const calibrated = applyThrowCalibration('egg', { velocity: 1.2 });
        expect(calibrated?.velocity).toBe(1.2);
        expect(throwProfileOf('egg')?.velocity).toBe(1.2);
        const after = solveBallisticPitch(40, 0, 1.2, 0.03);
        expect(after).not.toBeNull();
        expect(after).not.toBeCloseTo(before as number, 3);
        resetThrowCalibrations();
        expect(throwProfileOf('egg')?.velocity).toBe(1.5);
        // 不认识的物品校准不了
        expect(applyThrowCalibration('diamond_sword', { velocity: 9 })).toBeNull();
    });
});

// ───────────────────────── 二、投掷：事实核验 ─────────────────────────

describe('throwItem：投掷与核验', () => {
    it('抛物线类：给目标就抬头（回执写明 v/g），数量确实少了才叫"投出"', async () => {
        const h = harness({
            items: [{ name: 'egg', count: 3 }],
            projectile: { name: 'egg', id: 11, from: { x: 1, y: 70, z: 0 }, step: { x: 1, y: 0, z: 0 }, steps: 4 },
        });
        const receipt = await throwItemSkill(h.bot, 'egg', 40, 70, 0, h.deps, FAST);

        expect(h.activated).toBe(1);
        expect(h.equipped).toBe('egg');
        // 40 格平射：解出来的 pitch 必须是"抬头"（负值），且回执写了 v/g
        expect(h.look?.pitch).toBeLessThan(0);
        expect(receipt).toContain('抬头');
        expect(receipt).toContain('v=1.5 格/刻、g=0.03 格/刻²');
        expect(receipt).toContain('投出：egg 3 → 2');
        expect(receipt).toContain('实体现身');
        expect(receipt).toContain('刻');
        // 可校准观测值：预测射程 vs 实测距离（"得看着适配"的数据来源）
        expect(receipt).toContain('校准用：');
        expect(receipt).toContain('预测平射射程');
        expect(h.count('egg')).toBe(2);
    });

    it('目标超出射程 → 明确说"打不到"，并且**一格都没扔**', async () => {
        const h = harness({ items: [{ name: 'ender_pearl', count: 2 }] });
        const receipt = await throwItemSkill(h.bot, 'ender_pearl', 100, 70, 0, h.deps, FAST);

        expect(receipt).toContain('打不到');
        expect(receipt).toContain('没有扔');
        expect(h.activated).toBe(0);
        expect(h.count('ender_pearl')).toBe(2);
        // 下一步是"走近一点"，而且是一条能照抄的调用
        expect(receipt.trimEnd().split('\n').at(-1)).toMatch(/^下一步（照做即可）：goToCoordinates\(x=-?\d+, y=\d+, z=-?\d+, closeness=2\)$/);
    });

    it('数量没少 → "没扔出去"（绝不假装成功）', async () => {
        const h = harness({
            items: [{ name: 'egg', count: 3 }],
            onActivate: () => {
                /* 服务端没采纳：什么都不做 */
            },
        });
        const receipt = await throwItemSkill(h.bot, 'egg', undefined, undefined, undefined, h.deps, FAST);

        expect(receipt).toContain('没扔出去');
        expect(receipt).toContain('数量没变（3 → 3）');
        expect(receipt).not.toContain('投出：');
        expect(receipt.trimEnd().split('\n').at(-1)).toBe('下一步（照做即可）：stats(type="inventory")');
    });

    it('扔出去了但没看到实体 → 如实说"没看到"，不编落点', async () => {
        const h = harness({
            items: [{ name: 'snowball', count: 2 }],
            onActivate: ({ items }) => {
                items[0].count -= 1;
            },
        });
        const receipt = await throwItemSkill(h.bot, 'snowball', undefined, undefined, undefined, h.deps, FAST);

        expect(receipt).toContain('投出：snowball 2 → 1');
        expect(receipt).toContain('没看到 snowball 实体');
        expect(receipt).toContain('拿不到落点数据');
    });

    it('物品不在背包 → 点名缺什么，并列出能扔的', async () => {
        const h = harness({ items: [{ name: 'egg', count: 2 }] });
        const receipt = await throwItemSkill(h.bot, 'ender_pearl', undefined, undefined, undefined, h.deps, FAST);

        expect(receipt).toContain('背包里没有 ender_pearl');
        expect(receipt).toContain('eggx2');
        expect(h.activated).toBe(0);
    });

    it('认不出的物品 → 拒绝并列出支持清单（不猜着扔）', async () => {
        const h = harness({ items: [{ name: 'diamond_sword', count: 1 }] });
        const receipt = await throwItemSkill(h.bot, 'diamond_sword', undefined, undefined, undefined, h.deps, FAST);

        expect(receipt).toContain('不认识 "diamond_sword"');
        for (const item of supportedThrowables()) expect(receipt).toContain(item);
        expect(h.activated).toBe(0);
    });

    it('目标坐标只给一部分 → 拒绝，不瞎瞄', async () => {
        const h = harness({ items: [{ name: 'egg', count: 1 }] });
        const receipt = await throwItemSkill(h.bot, 'egg', 10, undefined, undefined, h.deps, FAST);
        expect(receipt).toContain('要么全给');
        expect(h.activated).toBe(0);
    });
});

// ───────────────────── 三、末影珍珠：等传送（事实） ─────────────────────

describe('末影珍珠：等坐标跳变', () => {
    it('坐标跳变 → 报落点 + 提醒固定 5 点伤害', async () => {
        const h = harness({
            items: [{ name: 'ender_pearl', count: 1 }],
            projectile: { name: 'ender_pearl', id: 7, from: { x: 1, y: 70, z: 0 }, step: { x: 1, y: 0, z: 0 }, steps: 3 },
            teleportTo: { x: 12, y: 68, z: 0 },
        });
        const receipt = await throwItemSkill(h.bot, 'ender_pearl', 12, 70, 0, h.deps, FAST);

        expect(receipt).toContain('传送：坐标跳到 (12, 68, 0)');
        expect(receipt).toContain('低 2.0 格');
        expect(receipt).toContain('固定吃 5 点伤害');
        expect(h.bot.entity.position).toEqual({ x: 12, y: 68, z: 0 });
    });

    it('没跳变 → 说"珠子扔出去了但没传送"（不假装到了）', async () => {
        const h = harness({
            items: [{ name: 'ender_pearl', count: 1 }],
            projectile: { name: 'ender_pearl', id: 7, from: { x: 1, y: 70, z: 0 }, step: { x: 1, y: 0, z: 0 }, steps: 3 },
        });
        const receipt = await throwItemSkill(h.bot, 'ender_pearl', 12, 70, 0, h.deps, FAST);

        expect(receipt).toContain('没传送');
        expect(receipt).not.toContain('坐标跳到');
        expect(h.bot.entity.position).toEqual({ x: 0, y: 70, z: 0 });
    });
});

// ─────────────── 四、末影之眼：走追踪，不走弹道（专门钉住） ───────────────

describe('末影之眼：制导类', () => {
    it('500 格外照扔不误（不做弹道解算），并报出 8 方位方向', async () => {
        const h = harness({
            items: [{ name: 'eye_of_ender', count: 1 }],
            yaw: 0,
            projectile: { name: 'eye_of_ender', id: 9, from: { x: 0, y: 70, z: 0 }, step: { x: 0, y: 0, z: 2 }, steps: 5 },
        });
        const receipt = await throwItemSkill(h.bot, 'eye_of_ender', 0, 70, 500, h.deps, FAST);

        expect(receipt).not.toContain('打不到'); // 弹道类在这里必红
        expect(receipt).toContain('制导类，不做弹道解算');
        expect(h.activated).toBe(1);
        // 眼睛朝 +z（南）飞 → 追踪报南；方向来自采样，不是编的
        expect(receipt).toContain('追踪：');
        expect(receipt).toContain('南（+Z）');
        expect(receipt).toContain('飞了约');
    });

    it('采样太少/位移太小 → 明确说"看不出方向"，不编', async () => {
        const h = harness({
            items: [{ name: 'eye_of_ender', count: 1 }],
            // 眼睛"在原地"（被墙挡住/没飞起来）：采样够了但位移 < 0.75 格
            projectile: { name: 'eye_of_ender', id: 9, from: { x: 0, y: 70, z: 0 }, step: { x: 0, y: 0, z: 0 }, steps: 5 },
        });
        const receipt = await throwItemSkill(h.bot, 'eye_of_ender', undefined, undefined, undefined, h.deps, FAST);
        expect(receipt).toContain('看不出方向');
    });

    it('眼睛没有实体可看 → 说"没看到实体，拿不到方向"', async () => {
        const h = harness({ items: [{ name: 'eye_of_ender', count: 1 }] });
        const receipt = await throwItemSkill(h.bot, 'eye_of_ender', undefined, undefined, undefined, h.deps, FAST);
        expect(receipt).toContain('没看到 eye_of_ender 实体');
        expect(receipt).toContain('别猜方向');
    });
});

// ───────────────────── 五、箭矢类：拉弓 → 放箭 ─────────────────────

describe('箭矢类：弓 + 蓄力 + 核对箭数', () => {
    it('自动拿弓、拉满 1000ms 再放箭；核对的是箭数', async () => {
        const h = harness({
            items: [
                { name: 'bow', count: 1 },
                { name: 'arrow', count: 5 },
            ],
            projectile: { name: 'arrow', id: 21, from: { x: 1, y: 70, z: 0 }, step: { x: 2, y: 0, z: 0 }, steps: 6 },
        });
        const receipt = await throwItemSkill(h.bot, 'arrow', 30, 70, 0, h.deps, FAST);

        expect(h.equipped).toBe('bow'); // 装备的是弓，不是箭
        expect(h.activated).toBe(1);
        expect(h.deactivated).toBe(1); // 两步时序
        expect(h.deactivateAt ?? 0).toBeGreaterThanOrEqual(1000); // 蓄力 ≥ 1000ms
        expect(receipt).toContain('投出：arrow 5 → 4');
        expect(h.count('arrow')).toBe(4);
    });

    it('有箭但没弓 → 明确说"射不出去"，不假装', async () => {
        const h = harness({ items: [{ name: 'arrow', count: 5 }] });
        const receipt = await throwItemSkill(h.bot, 'arrow', 30, 70, 0, h.deps, FAST);
        expect(receipt).toContain('没有弓');
        expect(h.activated).toBe(0);
        expect(h.count('arrow')).toBe(5);
    });
});

// ───────────────────────── 六、接线 / 门禁 ─────────────────────────

describe('接线：registry 与 schema', () => {
    it('throwItem 注册成 action + longRunning', () => {
        expect(toolNames()).toContain('throwItem');
        expect(findCommand('throwItem')?.name).toBe('!throwItem');
        expect(throwingActionList.map((c) => c.name)).toEqual(['!throwItem']);
        const declaration = toolDeclarations().find((d) => d.name === 'throwItem');
        expect(declaration?.kind).toBe('action');
        expect(declaration?.longRunning).toBe(true);
    });

    it('参数顺序 = perform 的位置参数顺序；每个 schema 参数都有 TOOL_TEXT 说明', () => {
        expect(Object.keys(findCommand('throwItem')?.params ?? {})).toEqual([
            'item_name',
            'target_x',
            'target_y',
            'target_z',
        ]);
        expect(throwingActionList[0].params?.item_name.optional).toBeUndefined(); // 必填
        expect(throwingActionList[0].params?.target_x.optional).toBe(true);

        const tools = getOpenAITools(toolDeclarations());
        const tool = tools.find((t) => t.function.name === 'throwItem');
        expect(tool).toBeDefined();
        const props = Object.keys((tool?.function.parameters as any).properties ?? {});
        expect(props).toEqual(['item_name', 'target_x', 'target_y', 'target_z']);
        for (const param of props) {
            expect((TOOL_TEXT as any).throwItem?.params?.[param], `throwItem.${param} 缺 TOOL_TEXT 说明`).toBeTruthy();
        }
    });

    it('投掷提醒里必须写清"没扔出去"这类事实口径（防止回执退化成"已投掷"）', () => {
        const description = String((TOOL_TEXT as any).throwItem?.description ?? '');
        expect(description).toContain('没扔出去');
        expect(description).toContain('制导');
    });
});

// 让 vi 的导入不被摇掉（harness 里没用 vi，但保持与其它测试一致的写法）
void vi;
