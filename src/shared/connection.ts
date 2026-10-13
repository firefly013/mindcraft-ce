/*
 * 连接错误分类：把 mineflayer / 服务器的踢出原因翻译成人话。
 *
 * 两侧共用同一份判据：身体侧拿它在断线时报清楚"是被踢了还是网络断了"，
 * 大脑侧拿它决定要不要重连。这里**不认识 MindServer**——只做纯分类，
 * 日志出口由各自那一侧的 `connection_handler.ts` 提供。
 */

interface ErrorDefinition {
    keywords: string[];
    msg: string;
    isFatal: boolean;
}

export interface KickInfo {
    type: string;
    msg: string;
    isFatal: boolean;
}

// Definitions of error types, keywords, and full human-readable messages.
const ERROR_DEFINITIONS: Record<string, ErrorDefinition> = {
    'name_conflict': {
        keywords: ['name_taken', 'duplicate_login', 'already connected', 'already logged in', 'username is already'],
        msg: 'Name Conflict: The name is already in use or you are already logged in.',
        isFatal: true
    },
    'access_denied': {
        keywords: ['whitelist', 'not white-listed', 'banned', 'suspended', 'verify'],
        msg: 'Access Denied: You are not whitelisted or banned.',
        isFatal: true
    },
    'server_full': {
        keywords: ['server is full', 'full server'],
        msg: 'Connection Failed: The server is full.',
        isFatal: false
    },
    'modded_client_required': {
        keywords: ['fabric loader', 'fabric api', 'registry entry namespaces'],
        msg: 'Modded Server Incompatibility: The server requires client-side mod support that Mindcraft cannot provide.',
        isFatal: true
    },
    'version_mismatch': {
        keywords: ['outdated client', 'outdated server', 'incompatible version', 'version mismatch'],
        msg: 'Version Mismatch: Client and server versions do not match.',
        isFatal: true
    },
    'maintenance': {
        keywords: ['maintenance', 'updating', 'closed', 'restarting'],
        msg: 'Connection Failed: Server is under maintenance or restarting.',
        isFatal: false
    },
    'network_error': {
        keywords: ['timeout', 'timed out', 'connection lost', 'reset', 'refused', 'keepalive'],
        msg: 'Network Error: Connection timed out or was lost.',
        isFatal: false
    },
    'behavior': {
        keywords: ['flying', 'spam', 'speed'],
        msg: 'Kicked: Removed from server due to flying, spamming, or invalid movement.',
        isFatal: true
    }
};

// Analyzes the kick reason and returns a full, human-readable sentence.
export function parseKickReason(reason: unknown): KickInfo {
    if (!reason) return { type: 'unknown', msg: 'Unknown reason (Empty)', isFatal: true };

    const raw = (typeof reason === 'string' ? reason : JSON.stringify(reason)).toLowerCase();

    // Search for keywords in definitions
    for (const [type, def] of Object.entries(ERROR_DEFINITIONS)) {
        if (def.keywords.some((k: string) => raw.includes(k))) {
            console.error(`Disconnected: ${raw}`);
            return { type, msg: def.msg, isFatal: def.isFatal };
        }
    }

    // Fallback: Extract text from JSON
    let fallback = raw;
    try {
        const obj = (typeof reason === 'string' ? JSON.parse(reason) : reason) as {
            translate?: unknown;
            text?: unknown;
            value?: { translate?: unknown };
        };
        fallback = String(obj.translate || obj.text || (obj.value?.translate) || raw);
    } catch (_: unknown) { void _; /* keep raw fallback on parse failure */ }

    return { type: 'other', msg: `Disconnected: ${fallback}`, isFatal: true };
}

// Validates name format.
export function validateNameFormat(name: string): { success: boolean; msg: string } {
    if (!name || !/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
        return {
            success: false,
            // Added [LoginGuard] prefix here for consistency
            msg: `[LoginGuard] Invalid name '${name}'. Must be 3-16 alphanumeric/underscore characters.`
        };
    }
    return { success: true, msg: '' };
}
