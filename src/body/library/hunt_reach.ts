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

export function isLandAnimal(name: string): boolean {
    const normalized = String(name ?? '')
        .toLowerCase()
        .replace(/^minecraft:/, '');
    return LAND_ANIMALS.has(normalized);
}

export interface WaterHuntStopInput {
    /** 从"开始追这个水里目标"到现在的毫秒数。 */
    elapsedMs: number;
    /** 与目标的距离（格）。 */
    distance: number;
    /** 本次 huntFor 已尝试次数（用于"第 N 次空转"）。 */
    attempts: number;
    /** 扫描到的附近陆生动物数量（0 = 没有；null = 没扫描/读不到）。 */
    landAnimals: number | null;
    /** 人是否已经在水里（在水里就照常追，不早停）。 */
    botInWater: boolean;
    /** 目标是否在水里。 */
    targetInWater: boolean;
    /** 目标名字（用于回执里写"鱼"）。 */
    targetName?: string;
}

export interface WaterHuntStop {
    stop: boolean;
    text: string;
}

/**
 * 是否该早停。条件：目标在水里、人不在水里、且已经空转 ≥20 秒、且附近没有陆生动物。
 * （有陆生动物就不早停——那条路更有希望；但也不阻止继续尝试。）
 */
export function planWaterHuntStop(input: WaterHuntStopInput): WaterHuntStop {
    if (input.botInWater || !input.targetInWater) return { stop: false, text: '' };
    if (input.landAnimals == null || input.landAnimals > 0) return { stop: false, text: '' };
    if (input.elapsedMs < HUNT_WATER_EARLY_STOP_MS) return { stop: false, text: '' };
    const target = String(input.targetName ?? '水生动物').replace(/^minecraft:/, '');
    const repeat =
        input.attempts >= 2
            ? `（这是第 ${input.attempts} 次空转——同样的死路不要再花整段预算）`
            : '';
    return {
        stop: true,
        text:
            `\`huntFor\` 停了：**${target} 在水里 ${Math.round(input.distance)} 格，我在岸上，下水追不到**${repeat}。` +
            '要么放弃水生猎物，要么换个方向找岸上的动物（附近 48 格内陆生动物：无）。' +
            '已经空转 ' + Math.round(input.elapsedMs / 1000) + ' 秒，没有移动也没有攻击命中。',
    };
}
