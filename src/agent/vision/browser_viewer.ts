import settings from '../settings.js';
import prismarineViewer from 'prismarine-viewer';

type MineflayerViewerFn = (bot: any, opts: Record<string, unknown>) => unknown; // mineflayer bot 无类型，统一 any
const mineflayerViewer = (prismarineViewer as unknown as { mineflayer: MineflayerViewerFn }).mineflayer;

export function addBrowserViewer(bot: any, count_id: number): void {
    if (settings.render_bot_view)
        mineflayerViewer(bot, { port: 3000+count_id, firstPerson: true, });
}
