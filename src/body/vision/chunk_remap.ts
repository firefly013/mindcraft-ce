/**
 * **把区块 JSON 里的 state id 翻译成渲染器认识的 id**（纯函数，不改原对象）。
 *
 * `prismarine-viewer` 的 `WorldView.loadChunk` 会 `column.toJson()` 然后把 JSON 丢给
 * 渲染器的 `World`（用渲染器自己的版本解）。我们在中间拦一道，只翻译 **state id**，
 * 不动结构、不动坐标、不动 bit 布局 —— 因为 palette/数据只是"索引 → state id"的查找表，
 * 换值不换形状。
 *
 * 形状按"见过的都对"处理（不同 prismarine-chunk 版本 `toJson` 可能是
 * `{ sectionIndex: stateId[] }`、`{ index: stateId }` 或 `{ palette: [...] }`）：
 *   - `number` ⇒ 当成 state id；
 *   - `number[]` / `Int32Array` 之类 ⇒ 逐项；
 *   - `{ palette: [...] }` ⇒ 只翻 palette；
 *   - 其它对象/数组 ⇒ 递归（有深度上限，防止病态结构）。
 *
 * 不能映射的 id **保持原样**（渲染器会画「?」——那正是我们要的诚实降级），
 * 绝不换成 0（那会被画成空气，静默撒谎）。
 */

const MAX_DEPTH = 6;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function remapValue(value: unknown, remap: (id: number) => number | null, depth: number): unknown {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return value;
        const mapped = remap(value);
        return mapped == null ? value : mapped;
    }
    if (depth > MAX_DEPTH) return value;
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
            const next = remapValue(item, remap, depth + 1);
            if (next !== item) changed = true;
            return next;
        });
        return changed ? out : value;
    }
    // 定型数组（Int32Array 等）：逐项翻译，转成普通数组（JSON 路径上本来就是数组）。
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const arr = Array.from(value as unknown as ArrayLike<number>);
        let changed = false;
        const out = arr.map((item) => {
            const next = remapValue(item, remap, depth + 1);
            if (next !== item) changed = true;
            return next;
        });
        return changed ? out : value;
    }
    if (!isPlainObject(value)) return value;
    // 只翻 palette（其它字段是几何/光照数据，别动）。
    if (Array.isArray(value.palette)) {
        const palette = value.palette;
        const nextPalette = palette.map((item) => {
            const next = remapValue(item, remap, depth + 1);
            return next;
        });
        const changed = nextPalette.some((item, i) => item !== palette[i]);
        return changed ? { ...value, palette: nextPalette } : value;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        const next = remapValue(item, remap, depth + 1);
        if (next !== item) changed = true;
        out[key] = next;
    }
    return changed ? out : value;
}

/**
 * 翻译一份区块 JSON 里的所有 state id。**永不抛**（出错就返回原值，让画面退化成"更破"
 * 而不是"崩溃/没有图"）。
 */
export function remapChunkJson<T>(json: T, remap: (id: number) => number | null): T {
    try {
        return remapValue(json, remap, 0) as T;
    } catch {
        return json;
    }
}

/** 单个 blockUpdate 的 state id 翻译（渲染器的增量更新走这里）。 */
export function remapBlockUpdateStateId(stateId: unknown, remap: (id: number) => number | null): unknown {
    const id = Number(stateId);
    if (!Number.isFinite(id)) return stateId;
    try {
        const mapped = remap(id);
        return mapped == null ? stateId : mapped;
    } catch {
        return stateId;
    }
}
