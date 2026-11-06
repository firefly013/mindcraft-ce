/**
 * 物品变体标签：**物品名相同、靠附加数据区分**的那些东西。
 *
 * 背包里所有药水都叫 `potion`、所有附魔书都叫 `enchanted_book`、所有药箭都叫
 * `tipped_arrow`——只显示物品名，模型根本看不出是哪一件。这里按同一套格式补一个
 * 后缀：`enchanted_book[mending]`、`diamond_sword[sharpness 5]`、
 * `tipped_arrow[poison]`、`suspicious_stew[regeneration 6s]`、
 * `goat_horn[seek]`、`firework_rocket[flight 3]`、`crossbow[loaded: arrow]`。
 *
 * 纪律：
 *   - 只读附加数据，不做任何判断/筛选；读不到就退回裸物品名（不知道 ≠ 没有）；
 *   - 列表中用 `;` 分隔而不是 `,`，因为 `input`/`output` 参数是按逗号拆物品的；
 *   - 不截断：有几种附魔就列几种。
 *
 * 纯函数，不 import mineflayer，可在单测里直接喂假物品。
 */
import { normalizeName, potionIdOf } from './endgame.js';

/** 铁砧类方块名（普通/轻微损坏/严重损坏）。 */
export const ANVIL_BLOCK_NAMES: readonly string[] = Object.freeze(['anvil', 'chipped_anvil', 'damaged_anvil']);

export function isAnvilBlockName(name: unknown): boolean {
    return ANVIL_BLOCK_NAMES.includes(normalizeName(name));
}

/**
 * 取某个组件的数据，兼容三种形状：
 *   - 1.20.5+：`item.componentMap`（Map<根据 type, {type,data}>）
 *   - 1.20.5+：`item.components`（[{type,data}]）
 *   - 旧代码/测试里的 `item.components.<type>`（直接是 data）
 */
export function componentDataOf(item: any, type: string): any {
    if (item == null) return null;
    const map = item.componentMap;
    if (map != null && typeof map.get === 'function') {
        const component = map.get(type);
        if (component != null) return component.data ?? component;
    }
    const components = item.components;
    if (Array.isArray(components)) {
        for (const component of components) {
            if (component?.type === type) return component.data ?? component;
        }
        return null;
    }
    if (components != null && typeof components === 'object') {
        const component = (components as Record<string, any>)[type];
        if (component != null) return component.data ?? component;
    }
    return null;
}

/** 旧版 NBT 的 value 对象（prismarine-item 的 `item.nbt.value`）。 */
function nbtValueOf(item: any): any {
    return item?.nbt?.value ?? null;
}

function numberOf(value: unknown): number | null {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function nameFromRegistry(registry: any, list: 'enchantmentsArray' | 'effectsArray' | 'instrumentsArray' | 'itemsArray', id: number | null): string | null {
    if (id == null) return null;
    const entry = registry?.[list]?.[id];
    const name = entry?.name;
    return typeof name === 'string' && name !== '' ? name : null;
}

// ============================ 各类变体 ============================

/** 附魔列表：`item.enchants` getter（旧版 + 1.20.5 的 enchantments 组件）+ 书本的 stored_enchantments。 */
export function enchantParts(item: any, registry: any): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: unknown): void => {
        const list = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.enchantments) ? (raw as any).enchantments : null;
        if (list == null) return;
        for (const entry of list) {
            if (entry == null || typeof entry !== 'object') continue;
            const e = entry as Record<string, any>;
            const lvl = numberOf(e.level ?? e.lvl);
            let name: string | null = typeof e.name === 'string' && e.name !== '' ? e.name : null;
            if (name == null) name = nameFromRegistry(registry, 'enchantmentsArray', numberOf(e.id));
            if (name == null) continue;
            const label = `${normalizeName(name)}${lvl == null ? '' : ` ${lvl}`}`;
            if (seen.has(label)) continue;
            seen.add(label);
            out.push(label);
        }
    };
    try {
        push(item?.enchants);
    } catch {
        // getter 在空物品/未知版本上可能抛，读不到就当没有。
    }
    push(componentDataOf(item, 'stored_enchantments'));
    push(componentDataOf(item, 'enchantments'));
    return out;
}

/** 迷之炖菜：效果 + 持续秒数（读数不可用就只写效果）。 */
function stewParts(item: any, registry: any): string[] {
    const out: string[] = [];
    const data = componentDataOf(item, 'suspicious_stew_effects');
    const effects = Array.isArray(data) ? data : Array.isArray(data?.effects) ? data.effects : null;
    if (effects != null) {
        for (const entry of effects) {
            const e = entry as Record<string, any>;
            const id = numberOf(e?.id ?? e?.effectId ?? e?.effect_id);
            let name = typeof e?.name === 'string' ? e.name : null;
            if (name == null) name = nameFromRegistry(registry, 'effectsArray', id);
            if (name == null) continue;
            const ticks = numberOf(e?.duration ?? e?.durationTicks);
            out.push(`${normalizeName(name)}${ticks == null ? '' : ` ${Math.round(ticks / 20)}s`}`);
        }
        return out;
    }
    // 旧版 NBT：Effects 是 list<compound>，每项 EffectId / EffectDuration。
    const legacy = nbtValueOf(item)?.Effects?.value?.value;
    if (Array.isArray(legacy)) {
        for (const entry of legacy) {
            const id = numberOf(entry?.EffectId?.value ?? entry?.EffectId);
            const ticks = numberOf(entry?.EffectDuration?.value ?? entry?.EffectDuration);
            const name = nameFromRegistry(registry, 'effectsArray', id);
            if (name == null) continue;
            out.push(`${normalizeName(name)}${ticks == null ? '' : ` ${Math.round(ticks / 20)}s`}`);
        }
    }
    return out;
}

/** 山羊角：instrument 组件/旧版 NBT。 */
function instrumentParts(item: any, registry: any): string[] {
    const data = componentDataOf(item, 'instrument');
    let name: string | null = null;
    if (typeof data === 'string') name = data;
    else if (data != null && typeof data === 'object') {
        name = typeof data.name === 'string' ? data.name : null;
        if (name == null) name = nameFromRegistry(registry, 'instrumentsArray', numberOf(data.instrumentId ?? data.id));
    }
    if (name == null) {
        const legacy = nbtValueOf(item)?.instrument?.value ?? nbtValueOf(item)?.instrument;
        if (typeof legacy === 'string') name = legacy;
    }
    return name == null ? [] : [normalizeName(name)];
}

/** 烟花火箭：飞行时长（组件/旧版 NBT）。 */
function fireworkParts(item: any): string[] {
    const data = componentDataOf(item, 'fireworks');
    const flight = numberOf(data?.flightDuration ?? data?.flight ?? nbtValueOf(item)?.Fireworks?.value?.Flight?.value);
    return flight == null ? [] : [`flight ${flight}`];
}

/** 装填的弩：装了什么弹。 */
function chargedProjectileParts(item: any, registry: any): string[] {
    const data = componentDataOf(item, 'charged_projectiles');
    const projectiles = Array.isArray(data) ? data : Array.isArray(data?.projectiles) ? data.projectiles : null;
    if (projectiles == null) {
        const legacy = nbtValueOf(item)?.ChargedProjectiles?.value?.value;
        return Array.isArray(legacy) && legacy.length > 0 ? ['loaded'] : [];
    }
    if (projectiles.length === 0) return [];
    const names: string[] = [];
    for (const projectile of projectiles) {
        const p = projectile as Record<string, any>;
        let name = typeof p?.name === 'string' ? p.name : null;
        if (name == null) name = nameFromRegistry(registry, 'itemsArray', numberOf(p?.itemId ?? p?.id));
        if (name != null) names.push(normalizeName(name));
    }
    return [names.length > 0 ? `loaded: ${names.join('; ')}` : 'loaded'];
}

/** 地图：地图编号（缩放/维度不在物品上，读不到就不写）。 */
function mapParts(item: any): string[] {
    const id = numberOf(componentDataOf(item, 'map_id') ?? nbtValueOf(item)?.map?.value ?? nbtValueOf(item)?.map);
    return id == null ? [] : [`map ${id}`];
}

/**
 * 一件物品的全部变体标签；没有变体返回空数组。
 *
 * 药水/喷溅/滞留由 `itemDisplayName` 直接换成药水 id，不走这里。
 */
export function itemVariantParts(item: any, registry: any = null): string[] {
    const name = normalizeName(item?.name);
    const parts: string[] = [];
    if (name === 'tipped_arrow') {
        const potion = potionIdOf(item);
        if (potion != null) parts.push(potion);
    }
    parts.push(...enchantParts(item, registry));
    if (name === 'suspicious_stew') parts.push(...stewParts(item, registry));
    if (name === 'goat_horn') parts.push(...instrumentParts(item, registry));
    if (name === 'firework_rocket') parts.push(...fireworkParts(item));
    if (name === 'crossbow') parts.push(...chargedProjectileParts(item, registry));
    if (name === 'filled_map' || name === 'map') parts.push(...mapParts(item));
    return parts;
}

/** 背包/手持显示用的名字：药水换成完整 id，其它变体加 `[...]` 后缀。 */
export function itemDisplayName(item: any, fallback: string, registry: any = null): string {
    const name = normalizeName(fallback);
    const potion = potionIdOf(item);
    if (potion != null && (name === 'potion' || name === 'splash_potion' || name === 'lingering_potion')) {
        return name === 'potion' ? potion : `${name}:${potion}`;
    }
    const parts = itemVariantParts(item, registry);
    return parts.length === 0 ? fallback : `${fallback}[${parts.join('; ')}]`;
}

// ============================ 按显示标签找回物品 ============================

/** 拆 `base[a; b]`。 */
export function splitItemLabel(label: string): { name: string; variants: string[] } {
    const text = String(label ?? '').trim();
    const match = /^([^[]+?)\s*\[([^\]]*)\]$/.exec(text);
    if (match == null) return { name: text, variants: [] };
    return {
        name: (match[1] ?? '').trim(),
        variants: (match[2] ?? '')
            .split(';')
            .map((part) => part.trim())
            .filter((part) => part !== ''),
    };
}

function labelsEqual(a: string, b: string): boolean {
    return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/**
 * 物品是否匹配模型写的标签。
 *
 * - 带方括号：必须和显示标签**逐字一致**（变体不同的两把剑不会互相匹配）；
 * - 裸名字：仍按物品名匹配（也认药水 id），维持原来“有就拿来用”的行为。
 */
export function itemMatchesLabel(item: any, label: string, registry: any = null): boolean {
    const text = String(label ?? '').trim();
    if (text === '') return false;
    if (labelsEqual(itemDisplayName(item, String(item?.name ?? ''), registry), text)) return true;
    const parsed = splitItemLabel(text);
    if (parsed.variants.length > 0) return false;
    if (normalizeName(item?.name) === normalizeName(parsed.name)) return true;
    const potion = potionIdOf(item);
    return potion != null && normalizeName(potion) === normalizeName(parsed.name);
}

/** 在背包里按显示标签找第一件物品。 */
export function findInventoryItemByLabel(bot: any, label: string, registry: any = null): any | null {
    let items: any[];
    try {
        const found = bot?.inventory?.items?.();
        items = Array.isArray(found) ? found : [];
    } catch {
        return null;
    }
    const reg = registry ?? bot?.registry ?? null;
    for (const item of items) {
        if (itemMatchesLabel(item, label, reg)) return item;
    }
    return null;
}
