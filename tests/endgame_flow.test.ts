/**
 * 末地通关**全流程**测试：证明"从什么都没有 → 龙死"这条链在决策层是走得通的。
 *
 * 为什么要有这个文件：单测证明了每个零件对（爆炸公式、闸门、取样方向…），但**没有证明
 * 它们接起来能走完**。这一轮的真实教训有两个：
 *
 * 1. **中段是断的**：阶段枚举里只有 `prepare → travel_stronghold`，从"没有烈焰棒"到
 *    "有烈焰棒"之间没有任何阶段 —— 模型在下界刷烈焰人这件事，决策层表达不出来。
 * 2. **末地里会被主世界的前置卡死**：`strongholdFound` / `portalActivated` 是主世界概念，
 *    而 `endFightStatus` 在末地读不到它们（永远是 undefined）—— 于是机器人站在末地中央，
 *    报告却让它"掷末影之眼找要塞"。
 *
 * 所以这里逐阶段驱动 `nextEndgameStep` / `endgameStatusReport`，并钉三条不变式：
 * - **不变式 1**：每个阶段都得说清"下一步做什么"（除了终态 `done`）；
 * - **不变式 2**：建议的工具名**必须能在 registry 里查到**（原来写死过不存在的工具名）；
 * - **不变式 3**：前置没满足时，回执要点名**缺什么**（数量），而不是只说"再准备准备"。
 *
 * 不连服务端、不烧 token：纯逻辑 + 假 bot。
 */
import { describe, expect, it } from 'vitest';
import { toolNames } from '../src/body/commands/registry.js';
import {
    BLAZE_RODS_FOR_EYES,
    END_PORTAL_EYES,
    PEARLS_FOR_EYES,
    assessEndGear,
    blazePowderAvailable,
    formatEndgameReport,
    nextEndgameStep,
    type EndgamePhase,
    type EndgameState,
} from '../src/body/library/endgame.js';
import { endgameStatusReport } from '../src/body/library/endgame_routine.js';

const CATALOG = new Set(toolNames());

/** 终态：`done` 现在也**给得出动作**（回主世界 / 花 4 颗末影水晶复活龙再打一次），只是不再推进阶段。 */
const TERMINAL_PHASES: readonly EndgamePhase[] = ['done'];

const ALL_PHASES: readonly EndgamePhase[] = [
    'recover',
    'prepare',
    'nether_fortress',
    'nether_blaze',
    'overworld_pearls',
    'craft_eyes',
    'travel_stronghold',
    'activate_portal',
    'enter_end',
    'clear_crystals',
    'fight_dragon',
    'done',
];

/**
 * 走一步并检查三条不变式。**所有场景都必须经过它**——这样"某个新阶段忘了给工具"
 * 会立刻红，而不是等模型在真机上撞到"未知工具"。
 */
function step(state: EndgameState) {
    const advice = nextEndgameStep(state);
    expect(ALL_PHASES, `未知阶段 ${advice.phase}`).toContain(advice.phase);
    expect(ALL_PHASES, `${advice.phase} 的 nextPhase 不是合法阶段`).toContain(advice.nextPhase);
    // 不变式 1：有话说（说清下一步）
    expect(advice.action.trim().length, `${advice.phase} 没给出动作`).toBeGreaterThan(8);
    expect(advice.reason.trim().length, `${advice.phase} 没给出原因`).toBeGreaterThan(4);
    // 不变式 2：工具真实存在。`done` 是终态，允许没有工具（但**有工具就必须是真的**）。
    if (!TERMINAL_PHASES.includes(advice.phase)) {
        expect(advice.tool, `${advice.phase} 没有工具 → 模型会卡住`).toBeDefined();
    }
    if (advice.tool != null) {
        expect(CATALOG.has(advice.tool), `${advice.phase} 建议的 ${advice.tool} 不在工具表里`).toBe(true);
    }
    return advice;
}

/** 完整装备（能过 assessEndGear 的硬缺口）：方块 + 弓 + 箭。 */
const KIT = { obsidian: 64, bow: 1, arrow: 32 };

function makeFakeBot(options: {
    dimension?: string;
    stacks?: Record<string, number>;
    entities?: Record<string, any>;
    bossBars?: any[];
} = {}) {
    const stacks = Object.entries(options.stacks ?? {}).map(([name, count]) => ({ name, count }));
    return {
        game: { dimension: options.dimension ?? 'minecraft:overworld' },
        entity: { position: { x: 0, y: 64, z: 0, offset: (dx: number, dy: number, dz: number) => ({ x: dx, y: 64 + dy, z: dz }) }, effects: {} },
        entities: options.entities ?? {},
        bossBars: options.bossBars,
        registry: { effects: {} },
        health: 20,
        food: 20,
        output: '',
        inventory: { slots: stacks, items: () => stacks },
    };
}

// ============================ 一、整条链一次走完（防死循环） ============================

describe('全流程：从零走到 done，每一步都必须真的推进', () => {
    /** 假装"模型照着建议做完了这一步"，把状态推一格。 */
    function followAdvice(state: EndgameState): EndgameState {
        const advice = nextEndgameStep(state);
        switch (advice.phase) {
            case 'recover':
                return { ...state, itemOnGround: false };
            case 'prepare':
                return { ...state, gearReady: true };
            case 'nether_fortress':
                return state.inNether === true ? { ...state, fortressFound: true } : { ...state, inNether: true };
            case 'nether_blaze':
                return { ...state, blazeRods: BLAZE_RODS_FOR_EYES, blazePowder: 0 };
            case 'overworld_pearls':
                return { ...state, enderPearls: PEARLS_FOR_EYES };
            case 'craft_eyes':
                return { ...state, eyesOfEnder: END_PORTAL_EYES };
            case 'travel_stronghold':
                return { ...state, strongholdFound: true };
            case 'activate_portal':
                return { ...state, portalActivated: true };
            case 'enter_end':
                return { ...state, inEnd: true, inNether: false, crystalsAlive: 10 };
            case 'clear_crystals':
                return { ...state, crystalsAlive: 0 };
            case 'fight_dragon':
                return { ...state, dragonAlive: false, dragonHealth: 0 };
            case 'done':
                return state;
            default:
                throw new Error(`未覆盖的阶段 ${advice.phase}`);
        }
    }

    it('阶段顺序就是设计稿的顺序，而且 20 步内必须走到 done', () => {
        let state: EndgameState = {
            gearReady: false,
            inNether: false,
            blazeRods: 0,
            blazePowder: 0,
            enderPearls: 0,
            eyesOfEnder: 0,
        };
        const phases: EndgamePhase[] = [];
        for (let guard = 0; guard < 20 && nextEndgameStep(state).phase !== 'done'; guard++) {
            const advice = step(state);
            phases.push(advice.phase);
            const next = followAdvice(state);
            // **防原地打转**：照着建议做完，状态必须真的变了。
            expect(next, `阶段 ${advice.phase} 做完状态没变，会死循环`).not.toEqual(state);
            state = next;
        }
        expect(nextEndgameStep(state).phase).toBe('done');
        expect(phases).toEqual([
            'prepare',
            'nether_fortress', // 先进下界
            'nether_fortress', // 到了下界再 exploreFor 找要塞（同一个阶段，两个不同的下一步）
            'nether_blaze',
            'overworld_pearls',
            'craft_eyes',
            'travel_stronghold',
            'activate_portal',
            'enter_end',
            'clear_crystals',
            'fight_dragon',
        ]);
    });

    it('中段三环各自可达：粉 → 珍珠 → 眼', () => {
        const base: EndgameState = { gearReady: true, inNether: true, fortressFound: true, blazeRods: 7, blazePowder: 0, enderPearls: 12, eyesOfEnder: 12 };
        // 粉够、珍珠不够 → 刷珍珠
        expect(step({ ...base, blazeRod: undefined, enderPearls: 3 } as EndgameState).phase).toBe('overworld_pearls');
        // 珍珠够、眼不够 → 合成
        expect(step({ ...base, eyesOfEnder: 2 }).phase).toBe('craft_eyes');
        // 都够 → 出发找要塞
        expect(step(base).phase).toBe('travel_stronghold');
    });
});

// ============================ 二、逐阶段场景（含失败边缘） ============================

describe('逐阶段：每个阶段都点名"缺什么 + 下一步做什么"', () => {
    it('prepare：清单有硬缺口时，报告要点名缺的项（不是"再准备准备"）', () => {
        const gear = assessEndGear({ inventory: {} });
        expect(gear.ok).toBe(false);
        const advice = step({ gearReady: gear.ok });
        expect(advice.phase).toBe('prepare');
        expect(advice.tool).toBe('endFightStatus');
        const report = formatEndgameReport(gear, advice);
        expect(report).toContain('缺口：');
        expect(report).toContain('没有任何能伤龙的手段');
        expect(report).toContain('一个方块都没有');
        // 下一步动作也写在里面
        expect(advice.action).toContain('床');
        expect(advice.action).toContain('方块');
    });

    it('没有弓/箭、也没有床和 TNT → 仍然是硬缺口（现在两把 bot 就是这样）', () => {
        const gear = assessEndGear({ inventory: { obsidian: 64, cooked_beef: 8 } });
        expect(gear.ok).toBe(false);
        expect(gear.fatal.join()).toContain('没有任何能伤龙的手段');
        expect(step({ gearReady: gear.ok }).phase).toBe('prepare');
    });

    it('没有方块 → 硬缺口（连落点都搭不出来）', () => {
        const gear = assessEndGear({ inventory: { white_bed: 4, bow: 1, arrow: 32 } });
        expect(gear.ok).toBe(false);
        expect(gear.fatal.join()).toContain('一个方块都没有');
    });

    it('nether_fortress（不在下界）→ enterNether，并说清为什么要粉', () => {
        const advice = step({ gearReady: true, inNether: false, blazeRods: 0, blazePowder: 0 });
        expect(advice.phase).toBe('nether_fortress');
        expect(advice.tool).toBe('enterNether');
        expect(advice.action).toContain('下界');
        expect(advice.action).toContain(`${END_PORTAL_EYES}`);
    });

    it('nether_fortress（在下界但没找到要塞）→ exploreFor(nether_bricks)', () => {
        const advice = step({ gearReady: true, inNether: true, fortressFound: false, blazeRods: 0, blazePowder: 0 });
        expect(advice.phase).toBe('nether_fortress');
        expect(advice.tool).toBe('exploreFor');
        expect(advice.action).toContain('nether_bricks');
    });

    it('nether_blaze：找到要塞后刷烈焰棒，want 按缺口算而不是死写 7', () => {
        const advice = step({ gearReady: true, inNether: true, fortressFound: true, blazeRods: 0, blazePowder: 0 });
        expect(advice.phase).toBe('nether_blaze');
        expect(advice.tool).toBe('huntFor');
        expect(advice.action).toContain('blaze');
        expect(advice.action).toContain(`0/${END_PORTAL_EYES}`);
        expect(advice.action).toContain(`want=${BLAZE_RODS_FOR_EYES}`); // 0 份粉 → 6 根 + 1 根容错

        // 已经有 11 份粉 → 只要 2 根（1 根够 + 1 根容错），不是无脑 7 根
        const few = step({ gearReady: true, inNether: true, fortressFound: true, blazeRods: 5, blazePowder: 1 });
        expect(few.action).toContain('want=2');

        // 一根棒都没有但有 11 份粉（比如别人给的）→ 也只差 1 份粉，同样只要 2 根
        const powderOnly = step({ gearReady: true, inNether: true, fortressFound: true, blazeRods: 0, blazePowder: 11 });
        expect(powderOnly.action).toContain('want=2');
        expect(powderOnly.action).toContain(`11/${END_PORTAL_EYES}`);
    });

    it('overworld_pearls：珍珠不够 → huntFor(enderman)，want 等于缺口', () => {
        const advice = step({ gearReady: true, inNether: true, fortressFound: true, blazeRods: 7, blazePowder: 0, enderPearls: 5 });
        expect(advice.phase).toBe('overworld_pearls');
        expect(advice.tool).toBe('huntFor');
        expect(advice.action).toContain('enderman');
        expect(advice.action).toContain('want=7');
        expect(advice.action).toContain(`5/${PEARLS_FOR_EYES}`);
    });

    it('craft_eyes：材料够了去合成，并提醒多留几颗掷眼', () => {
        const advice = step({ gearReady: true, blazeRods: 7, blazePowder: 0, enderPearls: 12, eyesOfEnder: 2 });
        expect(advice.phase).toBe('craft_eyes');
        expect(advice.tool).toBe('craft');
        expect(advice.action).toContain('ender_eye');
        expect(advice.action).toContain(`2/${END_PORTAL_EYES}`);
        expect(advice.action).toContain('20%'); // 掷眼会碎
    });

    it('travel_stronghold：有 12 颗眼 → 掷眼；眼用光了要当场说', () => {
        const ok = step({ gearReady: true, blazeRods: 7, blazePowder: 0, enderPearls: 12, eyesOfEnder: 12 });
        expect(ok.phase).toBe('travel_stronghold');
        expect(ok.tool).toBe('throwHeld');
        expect(ok.action).toContain('12 颗眼');

        const out = step({ gearReady: true, blazeRods: 7, blazePowder: 0, enderPearls: 12, eyesOfEnder: 0 });
        // 眼用光了：材料链会把它推回 craft_eyes，而不是让它继续瞎扔
        expect(out.phase).toBe('craft_eyes');
    });

    it('activate_portal：有眼 → enterEnd；一颗眼都没有 → 明确让你先补眼', () => {
        const withEyes = step({ gearReady: true, strongholdFound: true, eyesOfEnder: 12 });
        expect(withEyes.phase).toBe('activate_portal');
        expect(withEyes.tool).toBe('enterEnd');

        const noEyes = step({ gearReady: true, strongholdFound: true, eyesOfEnder: 0 });
        expect(noEyes.phase).toBe('activate_portal');
        expect(noEyes.tool).toBe('huntFor');
        expect(noEyes.action).toContain('一颗末影之眼都没有');
    });

    it('enter_end：传送门激活了就走进去', () => {
        const advice = step({ gearReady: true, strongholdFound: true, portalActivated: true, inEnd: false });
        expect(advice.phase).toBe('enter_end');
        expect(advice.tool).toBe('enterEnd');
        expect(advice.action).toContain('100,49,0');
    });

    it('clear_crystals：剩几颗说几颗；没箭了要当场说不能射', () => {
        const partly = step({ gearReady: true, inEnd: true, crystalsAlive: 3, arrows: 40 });
        expect(partly.phase).toBe('clear_crystals');
        expect(partly.tool).toBe('clearEndCrystals');
        expect(partly.action).toContain('还剩 3 颗');

        const noArrows = step({ gearReady: true, inEnd: true, crystalsAlive: 3, arrows: 0 });
        expect(noArrows.phase).toBe('clear_crystals');
        expect(noArrows.action).toContain('箭是 0');
        expect(noArrows.action).toContain('TNT');
    });

    it('fight_dragon：水晶清完 → 床炸；没床就改打法（末地里出不去）', () => {
        const bomb = step({ gearReady: true, inEnd: true, crystalsAlive: 0, beds: 4, dragonHealth: 200, dragonAlive: true });
        expect(bomb.phase).toBe('fight_dragon');
        expect(bomb.tool).toBe('bedBombDragon');

        const noBedsInEnd = step({ gearReady: true, inEnd: true, crystalsAlive: 0, beds: 0, dragonHealth: 200, dragonAlive: true });
        expect(noBedsInEnd.phase).toBe('fight_dragon');
        expect(noBedsInEnd.tool).toBe('attack');
        expect(noBedsInEnd.action).toContain('床已经用光了');

        const noBedsOutside = step({ gearReady: true, inEnd: false, strongholdFound: true, portalActivated: true, crystalsAlive: 0, beds: 0 });
        // 不在末地时床的问题在"准备"阶段就该解决；这里只保证仍然给得出动作
        expect(noBedsOutside.tool).toBeDefined();
    });

    it('done：龙死了给收尾动作，且不再建议任何工具', () => {
        const advice = step({ gearReady: true, inEnd: true, crystalsAlive: 0, dragonHealth: 0, dragonAlive: false });
        expect(advice.phase).toBe('done');
        expect(advice.action).toContain('出口传送门');
        expect(advice.action).toContain('12000');
    });
});

describe('失败边缘：死了、拆一半、龙状态读不到', () => {
    it('战斗中死亡（地上有东西）→ 回收优先，压过打龙', () => {
        const advice = step({ itemOnGround: true, gearReady: true, inEnd: true, crystalsAlive: 4, dragonHealth: 150, dragonAlive: true });
        expect(advice.phase).toBe('recover');
        expect(advice.tool).toBe('recoverAfterDeath');
        expect(advice.action).toContain('回收');
    });

    it('水晶拆一半、龙在飞 → 继续拆，不许跳过去打龙', () => {
        const advice = step({ gearReady: true, inEnd: true, crystalsAlive: 6, dragonHealth: 180, dragonAlive: true });
        expect(advice.phase).toBe('clear_crystals');
    });

    it('龙状态失同步（实体没了但 boss bar 也没了）→ 按打完处理，但提示复核', () => {
        const advice = step({ gearReady: true, inEnd: true, crystalsAlive: 0, dragonHealth: null, dragonAlive: false });
        expect(advice.phase).toBe('done');
        expect(advice.reason).toContain('复核');
    });

    it('龙血读不到、实体还在 → 继续打，绝不误判成打完', () => {
        const advice = step({ gearReady: true, inEnd: true, crystalsAlive: 0, dragonHealth: null, dragonAlive: true });
        expect(advice.phase).toBe('fight_dragon');
    });

    it('水晶数读不到 → 保守按"还没拆完"处理', () => {
        const advice = step({ gearReady: true, inEnd: true, dragonHealth: 200, dragonAlive: true });
        expect(advice.phase).toBe('clear_crystals');
        expect(advice.action).toContain('读不到');
    });
});

// ============================ 三、状态报告（模型实际看到的那段字） ============================

describe('endFightStatus 报告：读 bot 状态能把阶段推对', () => {
    it('**站在末地里不能再让人去掷眼找要塞**（主世界前置不该卡住末地）', () => {
        const bot = makeFakeBot({
            dimension: 'the_end',
            stacks: KIT,
            entities: { 1: { name: 'end_crystal', position: { x: 20, y: 70, z: 0 } } },
        });
        const report = endgameStatusReport(bot);
        expect(report).not.toContain('travel_stronghold');
        expect(report).not.toContain('activate_portal');
        expect(report).toContain('clear_crystals');
        expect(report).toContain('水晶 1 颗');
    });

    it('在下界、没粉没要塞 → 报告直接说去 exploreFor 找 nether_bricks', () => {
        const bot = makeFakeBot({ dimension: 'minecraft:the_nether', stacks: KIT });
        const report = endgameStatusReport(bot);
        expect(report).toContain('nether_fortress');
        expect(report).toContain('exploreFor');
        expect(report).toContain('nether_bricks');
        expect(report).toContain('【眼的材料】');
    });

    it('在末地、水晶清完、龙还在 → 报告给床炸阶段与闸门状态', () => {
        const bot = makeFakeBot({
            dimension: 'the_end',
            stacks: { ...KIT, white_bed: 2 },
            entities: { 1: { name: 'ender_dragon', position: { x: 0, y: 65, z: 0 } } },
            bossBars: [{ title: 'Ender Dragon', health: 0.5 }],
        });
        const report = endgameStatusReport(bot);
        expect(report).toContain('fight_dragon');
        expect(report).toContain('100/200');
        expect(report).toContain('床炸闸门');
    });
});

// ============================ 四、穷举扫描：没有死路 ============================

describe('穷举状态组合：每个组合都必须给得出下一步', () => {
    it('关键布尔位笛卡尔积，全部满足三条不变式', () => {
        const flags = [true, false, undefined];
        let checked = 0;
        for (const inEnd of flags) {
            for (const itemOnGround of flags) {
                for (const gearReady of [true, false]) {
                    for (const strongholdFound of flags) {
                        for (const portalActivated of flags) {
                            for (const crystalsAlive of [undefined, 0, 5]) {
                                for (const dragonAlive of flags) {
                                    for (const dragonHealth of [undefined, null, 0, 200]) {
                                        const state: EndgameState = {
                                            inEnd,
                                            itemOnGround,
                                            gearReady,
                                            strongholdFound,
                                            portalActivated,
                                            crystalsAlive,
                                            dragonAlive,
                                            dragonHealth,
                                            // 材料链全给"够"：这一段有自己的场景，这里只扫阶段机
                                            blazeRods: 7,
                                            blazePowder: 0,
                                            enderPearls: 12,
                                            eyesOfEnder: 12,
                                        };
                                        step(state);
                                        checked++;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        expect(checked).toBeGreaterThan(500);
    });

    it('材料链的信号缺失时**不介入**（读不到就不猜，回落到原有阶段）', () => {
        const advice = step({ gearReady: true, strongholdFound: false });
        expect(advice.phase).toBe('travel_stronghold');
        expect(advice.tool).toBe('throwHeld');
    });
});

describe('折算函数：棒/粉换算只影响材料判断', () => {
    it('1 根棒 = 2 份粉；坏数据当 0', () => {
        expect(blazePowderAvailable(6, 0)).toBe(12);
        expect(blazePowderAvailable(0, 12)).toBe(12);
        expect(blazePowderAvailable(undefined, undefined)).toBe(0);
        expect(blazePowderAvailable(-3, Number.NaN)).toBe(0);
    });
});
