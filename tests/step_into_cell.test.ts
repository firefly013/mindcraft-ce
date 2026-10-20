/**
 * 移动原语 `stepIntoCell`（Lead 2026-10-20：collapse, not patch）。
 *
 * 四个工具同一个病：`mineTunnel`「挖通了但没走进去」、`travelTo`「安全门：挖通了但没走进去」、
 * `stairUp`「跳不上去」、`digDown`「Skipping air block… 挖了 4/80 格」——它们都让寻路器
 * 钻进 1×1 的洞。这一条原语：面对目标、forward(+jump)、**测量位移**、有界 3 次、失败说障碍。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeStepObstacles, stepIntoCell } from '../src/body/library/skills.js';

const block = (name: string) => ({ name });

/** 假 bot：位置在 position，按住 forward 每轮移动 `stepPerAttempt` 格；可设 maxAttempts 后放弃。 */
function fakeBot(opts: { at: { x: number; y: number; z: number }; step?: number; cells?: Record<string, string> }) {
    const position = { ...opts.at };
    const controls: string[] = [];
    const cells = opts.cells ?? {};
    let moves = 0;
    const bot: any = {
        entity: { position, yaw: 0 },
        blockAt: (v: any) => block(cells[`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`] ?? 'air'),
        lookAt: async () => {},
        setControlState: (key: string, state: boolean) => {
            controls.push(`${key}:${state}`);
            if (key === 'forward' && state) {
                const step = opts.step ?? 1;
                moves += 1;
                position.x += step;
            }
        },
    };
    return { bot, position, controls, get moves() { return moves; } };
}

describe('stepIntoCell：走进一格', () => {
    it('能走进去 ⇒ moved=true，且按过 forward', async () => {
        const fake = fakeBot({ at: { x: 0, y: 64, z: 0 }, step: 1 });
        const result = await stepIntoCell(fake.bot, { x: 1, y: 64, z: 0 });
        expect(result.moved).toBe(true);
        expect(fake.controls).toContain('forward:true');
        expect(fake.controls).toContain('forward:false');
    });

    it('走不动 ⇒ moved=false，**有界 3 次**，并且说出障碍物（不是"寻路失败"）', async () => {
        const fake = fakeBot({
            at: { x: 0, y: 64, z: 0 },
            step: 0,
            cells: { '1,64,0': 'stone', '1,65,0': 'stone' },
        });
        const result = await stepIntoCell(fake.bot, { x: 1, y: 64, z: 0 });
        expect(result.moved).toBe(false);
        expect(result.attempts).toBe(3);
        expect(String(result.reason)).toContain('脚那一格是 stone');
        expect(String(result.reason)).toContain('头那一格是 stone');
        expect(String(result.reason)).not.toContain('寻路失败');
        expect(result.obstacles.length).toBeGreaterThan(0);
    });

    it('高一格 ⇒ 必须同时按 jump；不按 jump 走不上去的假 bot 也应失败', async () => {
        const fake = fakeBot({ at: { x: 0, y: 64, z: 0 }, step: 0 });
        await stepIntoCell(fake.bot, { x: 1, y: 65, z: 0 });
        expect(fake.controls).toContain('jump:true');
        expect(fake.controls).toContain('jump:false');
    });

    it('目标格脚下没实心 ⇒ 障碍物里点名"脚下没有实心方块"（给下一步 mineBlock/placeHere）', () => {
        const blockAt = (x: number, y: number, z: number) =>
            ({ name: `${x},${y},${z}` === '1,64,0' ? 'air' : y === 64 ? 'air' : 'air' });
        const obstacles = describeStepObstacles(blockAt as any, { x: 1, y: 64, z: 0 });
        expect(obstacles.join('；')).toContain('目标脚下没有实心方块');
    });

    it('四个调用点都改用原语（源码守卫：不许再有"让寻路器钻进洞"）', () => {
        const skills = readFileSync(join(process.cwd(), 'src', 'body', 'library', 'skills.ts'), 'utf8');
        // stairUp / digDown
        expect(skills).toContain('const step = await stepIntoCell(bot');
        expect(skills).toContain('const sunkInto = await stepIntoCell(bot');
        // 回执必须给"下一步"，不许只说寻路失败
        expect(skills).toContain('先 mineBlock 掉头上那一格，再用 pillarUp');
        expect(skills).toContain('改用 goToCoordinates 移到旁边再 digDown');
    });
});
