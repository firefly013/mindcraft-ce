/**
 * 开发者通道（`bots/<name>/inbox.txt`）的读取逻辑。
 *
 * **单独成文件是为了能测**。这段逻辑有两个真机上踩过的坑，都属于"看起来对、
 * 实际操作下就丢数据"的类型：
 *
 * 1. **文件可能被截断重写**，而不是只追加。`printf '...' > inbox.txt` 就是
 *    截断重写——真机测试里这么写，三条消息每条都只剩下尾部，头部凭空消失。
 *    只在 `offset` 上做"变短就归零"的守卫接不住这种情况（见 `InboxCursor`）。
 * 2. **末尾可能只有半行**。写到一半就被读到，按字节切会在多字节字符中间断开，
 *    切出来的半个字变成 `�`，而且游标会停在字符中间，下一轮从那儿开始又是错的。
 *
 * 所以这里只做两件事：认得出文件被重写过；只交完整行。**没交出去的部分不推进游标。**
 */

/** 头部指纹取多少字节。 */
export const INBOX_PREFIX_BYTES = 64;

/** 读游标：读到哪了 + 当时文件头部长什么样。 */
export interface InboxCursor {
    offset: number;
    /** 文件前 `INBOX_PREFIX_BYTES` 字节的 base64；`''` 表示空文件或还没读过。 */
    prefix: string;
}

export const EMPTY_CURSOR: InboxCursor = { offset: 0, prefix: '' };

/**
 * 游标落盘。**重启不该重放旧指令**——身体重启后把上一次的开发者消息又推一遍，
 * 在大脑看来就是"人又说了一遍"，会白白多跑一轮推理。
 *
 * ⚠️ **必须连指纹一起存**。只存 `offset` 会把 D-45 那个 bug 带回来：文件被
 * 截断重写之后，一个孤零零的 offset 对新内容毫无意义，会正好落在消息中间。
 */
export function encodeCursor(cursor: InboxCursor): string {
    return JSON.stringify({ v: 1, offset: cursor.offset, prefix: cursor.prefix });
}

/**
 * 还原游标。**任何不认识的形状都当"没读过"**（offset=0）——一个坏掉的游标文件
 * 最坏的后果应该是"重放一次 inbox"，不该是"永远读不到"或者抛异常让身体起不来。
 */
export function decodeCursor(raw: string): InboxCursor {
    try {
        const parsed = JSON.parse(raw) as { offset?: unknown; prefix?: unknown };
        const offset = typeof parsed.offset === 'number' && parsed.offset >= 0 ? parsed.offset : 0;
        const prefix = typeof parsed.prefix === 'string' ? parsed.prefix : '';
        return { offset, prefix };
    } catch {
        return EMPTY_CURSOR;
    }
}

export interface InboxRead {
    /** 本次要投递的完整行（已 trim，已去掉空行）。 */
    lines: string[];
    /** 推进后的游标。 */
    cursor: InboxCursor;
}

/**
 * 从一整份文件内容里取出"还没有投递过的完整行"。
 *
 * @param content 文件**从 0 开始**的全部字节（调用方负责读全）。
 *                传全量而不是增量，是为了能算头部指纹——见 `InboxCursor`。
 * @param cursor  上一次的游标。
 */
export function readInbox(content: Buffer, cursor: InboxCursor): InboxRead {
    const headLen = Math.min(INBOX_PREFIX_BYTES, content.length);
    const head = content.subarray(0, headLen);
    const prefix = head.toString('base64');

    // 指纹按**公共前缀**比，不能整体比：文件短于 64 字节时，头部窗口就是整个
    // 文件，追加会让它变长——整体比会把"追加"误判成"重写"，于是重复投递。
    // （这条是单测抓出来的，不是想出来的。）
    const stored = Buffer.from(cursor.prefix, 'base64');
    const compareLen = Math.min(head.length, stored.length);
    const sameFile =
        compareLen > 0 && head.subarray(0, compareLen).equals(stored.subarray(0, compareLen));

    // 指纹变了 = 文件被重写过，旧 offset 对新内容毫无意义，一律归零。
    // 不能只用"长度变短"判断——重写后的内容**更长**时那个守卫不触发，
    // 于是会从旧 offset 处读新内容，正好落在消息中间（真机就是这么丢的头部）。
    const offset = sameFile ? cursor.offset : 0;
    if (offset >= content.length) {
        return { lines: [], cursor: { offset, prefix } };
    }

    // 游标里的 offset 可能不是字符边界（旧版本算错过，见下）。先把它挪到边界上，
    // 否则解码出来的第一个字符就是 `�`，而且**误差会逐轮累积**。
    const from = snapToCharBoundary(content, offset);

    // ── 全程在 **Buffer** 上定位，不经过字符串 ──────────────────────────────
    //
    // 以前是 `chunk = subarray(offset).toString('utf8')`，再拿
    // `Buffer.byteLength(complete) + 1` 反算下一个字节偏移。这条路的毛病：
    // `complete` 一旦含 `�`（offset 落在多字节字符中间时必然含），它的
    // `byteLength` 是 **3**，而那个残字在原文里可能只占了 1 个字节——
    // 于是游标每轮多跳 2 字节，越跳越偏，消息头部持续变成乱码。真机表现就是
    // 模型收到的 `{"source":"developer","message":"\ufffd具，不要输出正文。"}`：
    // 第一个字「调」（3 字节）被吃掉 1 字节，剩下的 2 字节解成 `�`。
    //
    // 在 Buffer 上直接找换行符就没有这个换算：`\n` 是 0x0A，而 UTF-8 里多字节
    // 字符的**后续字节恒为 0x80–0xBF**，不可能等于 0x0A，所以"最后一个换行的
    // 下一个字节"**必然**是一个字符的起始字节。游标因此永远落在边界上。
    // `lastIndexOf` 从后往前找，拿到的就是全局最后一个换行；它若落在 `from`
    // 之前，说明 `from` 之后一行都没写完整。
    const nl = content.lastIndexOf(NEWLINE);
    if (nl < from) {
        // 末尾那半行**留着**——不推进游标，下一轮连同它的后半截一起读。
        return { lines: [], cursor: { offset: from, prefix } };
    }

    const complete = content.subarray(from, nl).toString('utf8');
    const nextOffset = nl + 1; // 字节位置，精确，不需要换算。
    const lines = complete
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');

    return { lines, cursor: { offset: nextOffset, prefix } };
}

/** `\n` 的字节值。 */
const NEWLINE = 0x0a;

/**
 * 把字节偏移挪到**字符边界**上。
 *
 * UTF-8 的后续字节恒为 `10xxxxxx`（0x80–0xBF）；第一个字节是 `0xxxxxxx`（ASCII）
 * 或 `11xxxxxx`（多字节起始）。所以往前退，退到不是"后续字节"为止，最多退 3 步。
 *
 * 为什么要它：游标是**字节**偏移，而它可能来自旧版本算错的值、或被别的实现写过。
 * 一旦它落在多字节字符中间，解码出来的第一个字符就是 `�`。与其让那个 `�` 混进
 * 消息（模型看到的就是 `具，不要输出正文。`），不如退半步，从那个字的开头读起——
 * 宁可重读一个字，也不要给模型一个乱码。
 */
export function snapToCharBoundary(content: Buffer, offset: number): number {
    let at = Math.min(Math.max(offset, 0), content.length);
    for (let back = 0; back < 3 && at > 0; back++) {
        const byte = content[at];
        // 不是"后续字节" → 这里就是一个字符的开头。
        if ((byte & 0xc0) !== 0x80) break;
        at--;
    }
    return at;
}
