import {
    getPosition,
    getBiomeName,
    getNearbyPlayerNames,
    getInventoryCounts,
    getNearbyEntityTypes,
    getBlockAtPosition,
    getFirstBlockAboveHead
} from "./world.js";

export interface FullStatePosition {
  x: number;
  y: number;
  z: number;
}

export interface FullState {
  name: string;
  gameplay: {
    position: FullStatePosition;
    dimension: string;
    gamemode: string;
    health: number;
    hunger: number;
    biome: string;
    weather: string;
    timeOfDay: number;
    timeLabel: string;
  };
  action: {
    current: string;
    kind: string;
    isIdle: boolean;
  };
  surroundings: {
    below: string;
    legs: string;
    head: string;
    firstBlockAboveHead: string;
  };
  inventory: {
    counts: Record<string, number>;
    stacksUsed: number;
    totalSlots: number;
    equipment: {
      helmet: string | null;
      chestplate: string | null;
      leggings: string | null;
      boots: string | null;
      mainHand: string | null;
    };
  };
  nearby: {
    players: string[];
    entityTypes: string[];
  };
}

export function getFullState(agent: any): FullState {
    const bot: any = agent.bot;

    const pos: any = getPosition(bot);
    const position: FullStatePosition = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    };

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time.timeOfDay < 12000) timeLabel = 'Afternoon';

    const below: string = getBlockAtPosition(bot, 0, -1, 0).name;
    const legs: string = getBlockAtPosition(bot, 0, 0, 0).name;
    const head: string = getBlockAtPosition(bot, 0, 1, 0).name;

    const players: string[] = getNearbyPlayerNames(bot);

    const helmet: any = bot.inventory.slots[5];
    const chestplate: any = bot.inventory.slots[6];
    const leggings: any = bot.inventory.slots[7];
    const boots: any = bot.inventory.slots[8];

    // Richer activity than a bare "Idle": a bot counts as idle (no action executing) even while
    // chatting, deciding its next move, or stopped. Surface those so the dashboard is meaningful.
    //
    // ⚠️ **身体反射也算"在干活"。** 真机 2026-10-18 15:56：快照写 `action idle`，而
    // speed 2.0-2.4、身体正被反射拖着走（模型据此以为可以发动作，结果全被拒）。
    // `isIdle()` 只回答"模型动作占没占通道"，所以这里必须问 `currentActionName()`
    // ——它把 autoPickup / escape 反射也算进去（见 MineflayerBody.currentActionName）。
    const currentName: string | null =
        typeof (agent as { currentActionName?: () => string | null }).currentActionName === 'function'
            ? (agent as { currentActionName: () => string | null }).currentActionName()
            : null;
    let activity: { current: string; kind: string };
    if (currentName != null && currentName !== '') {
        activity = { current: currentName, kind: 'acting' };
    } else if (!agent.isIdle()) {
        activity = { current: agent.actions.currentActionLabel || 'Acting', kind: 'acting' };
    } else {
        activity = { current: 'Idle', kind: 'idle' };
    }

    const state: FullState = {
        name: agent.name,
        gameplay: {
            position,
            dimension: bot.game.dimension,
            gamemode: bot.game.gameMode,
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            biome: getBiomeName(bot),
            weather,
            timeOfDay: bot.time.timeOfDay,
            timeLabel
        },
        action: {
            current: activity.current,
            kind: activity.kind,
            isIdle: agent.isIdle()
        },
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: getFirstBlockAboveHead(bot, null, 32)
        },
        inventory: {
            counts: getInventoryCounts(bot),
            stacksUsed: bot.inventory.items().length,
            totalSlots: bot.inventory.slots.length,
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null
            }
        },
        nearby: {
            players,
            entityTypes: getNearbyEntityTypes(bot).filter((t: string) => t !== 'player' && t !== 'item'),
        }
    };

    return state;
}
