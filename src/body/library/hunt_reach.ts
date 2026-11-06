/**
 * **`huntFor` 岸上追水里的鱼：早停，而不是烧 60 秒**（Lead 2026-10-21 真机 A：
 * 饱食度 0、`huntFor(salmon, want=4, radius=48)`，60 秒完全没动也没打到任何东西——
 * 寻路器停在水边，"自动离水"反射又把它拉回岸上，两条规则互相抵消）。
 *
 * 纯判据：不移动、不需要 bot，可单测。
 * 原则：**下水不禁止**（人已在水里、目标在岸上/水边照常打）；只是"隔着水追不到"时
 * 早停并给两个可执行选项，别把整段预算花在"学不到任何东西"上。
 */
export const HUNT_WATER_EARLY_STOP_MS = 20_000;

/** 水生目标（在水里追不到，除非自己已经下水）。 */
const AQUATIC = new Set([
    'salmon', 'cod', 'tropical_fish', 'pufferfish', 'squid', 'glow_squid', 'dolphin', 'turtle', 'axolotl', 'guardian',
]);

const LAND_ANIMALS = new Set([
    'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule', 'goat', 'fox', 'wolf', 'llama', 'panda',
    'mooshroom', 'polar_bear', 'turtle', 'bee', 'cat', 'ocelot', 'parrot', 'frog', 'camel', 'sniffer',
]);

export function isAquaticTarget(name: string): boolean {
    const normalized = String(name ?? '')
        .toLowerCase()
        .replace(/^minecraft:/, '');
    return [...AQUATIC].some((entry) => normalized === entry || normalized.includes(entry));
}

/**
 * **打不还手的食物动物**：牛/猪/羊/鸡/兔/蘑菇牛/海龟——攻击它们玩家一滴血都不会掉。
 * （山羊会顶、猪灵蛮兽会主动攻击、羊驼会吐口水，所以都不在这份名单里。）
 *
 * 用途：`huntFor` 的**低血门控（血量 ≤6 就停手）对它们不生效**。
 * 那条门控的本意是"快死了别去打会还手的东西"，可它把唯一安全的回血路也堵死了：
 * 真机 2026-10-23 —— 血 4.17、食物 5、背包全空，`huntFor(cow)` 和手动找食物全部立刻收手，
 * 而食物 <18 时 Minecraft 根本不启动自然回血 ⇒ **低血 → 不敢打 → 更没血**的死锁。
 * 牛猪羊鸡不会还手，血再低打它们也不增加死亡风险，所以这条门控不该拦它们。
 */
const HARMLESS_FOOD_MOBS = new Set([
    'cow',
    'mooshroom',
    'pig',
    'sheep',
    'chicken',
    'rabbit',
    'turtle',
]);

export function isHarmlessFoodMob(name: string): boolean {
    const normalized = String(name ?? '')
        .toLowerCase()
        .replace(/^minecraft:/, '');
    return HARMLESS_FOOD_MOBS.has(normalized);
}

export function isLandAnimal(name: string): boolean {
    const normalized = String(name ?? '')
        .toLowerCase()
        .replace(/^minecraft:/, '');
    return LAND_ANIMALS.has(normalized);
}

export interface WaterHuntNoticeInput {
    /** 从"开始追这个水里目标"到现在的毫秒数。 */
    elapsedMs: number;
    /** 与目标的距离（格）。 */
    distance: number;
    /** 本次 huntFor 已尝试次数（用于"第 N 次空转"）。 */
    attempts: number;
    /** 扫描到的附近陆生动物数量（0 = 没有；null = 没扫描/读不到）。 */
    landAnimals: number | null;
    /** 人是否已经在水里（在水里就照常追）。 */
    botInWater: boolean;
    /** 目标是否在水里。 */
    targetInWater: boolean;
    /** 目标名字（用于回执里写"鱼"）。 */
    targetName?: string;
}

export interface WaterHuntNotice {
    /** true = 该把这条事实报给模型（调用方决定只报一次，防刷屏）。 */
    notice: boolean;
    text: string;
}

/**
 * 水中目标的**事实提示**（2026-10-24 起不再早停）。
 *
 * 以前这个函数叫 `planWaterHuntStop`：岸上追水里空转 20 秒就替模型收工
 * （`water_unreachable`）。那是用「耗了很久」猜「你肯定拿不到」——违反
 * "模型想干什么只有它自己知道"：目标在水里泡一会儿可能自己上岸，或者模型
 * 就是要等它、就是想把它引过来。现在只产出事实（距离/已空转多久/附近还有
 * 什么可打的），**照常追**；停不停由模型 Stop 或它自己设的预算/次数上限决定。
 */
export function planWaterHuntNotice(input: WaterHuntNoticeInput): WaterHuntNotice {
    if (input.botInWater || !input.targetInWater) return { notice: false, text: '' };
    if (input.landAnimals == null || input.landAnimals > 0) return { notice: false, text: '' };
    if (input.elapsedMs < HUNT_WATER_EARLY_STOP_MS) return { notice: false, text: '' };
    const target = String(input.targetName ?? '水生动物').replace(/^minecraft:/, '');
    const repeat = input.attempts >= 2 ? `，这已经是第 ${input.attempts} 次空转` : '';
    return {
        notice: true,
        text:
            `${target} 还在水里，离我 ${Math.round(input.distance)} 格，我在岸上守着${repeat}。` +
            `到现在已经空了 ${Math.round(input.elapsedMs / 1000)} 秒，这段时间没有移动，也没有打中任何东西。` +
            '附近 48 格内没有陆生动物。',
    };
}
