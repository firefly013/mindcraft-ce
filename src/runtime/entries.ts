/**
 * P3：自定义 entry 种类。
 *
 * `mc.say` 是 Say + 自动散文**双通道**里的显式那一条：模型主动说话时，
 * 除了成为 `pi.tool-result`，还落一条自己的 entry，前端和审计都能独立看到，
 * 不用去解析工具结果文本。
 *
 * 散文通道不在这里——那是 `pi.assistant`，由 pi-durable 的 generation 自然产生。
 */
import { defineEntry } from '@earendil-works/pi-durable';

/** 模型主动说话（Say 工具）的独立 entry。 */
export const SayEntry = defineEntry<{ text: string }>('mc.say');
