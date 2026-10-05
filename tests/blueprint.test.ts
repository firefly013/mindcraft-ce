import { describe, expect, it, vi } from 'vitest';
import {
  Blueprint,
  ConstructionTaskValidator,
  checkBlueprint,
  checkLevelBlueprint,
  resetConstructionWorld,
} from '../src/agent/tasks/construction_tasks.js';
import type { BlueprintData } from '../src/agent/tasks/construction_tasks.js';

// The world the fake bot sees: "x,y,z" -> block name. Absent = null (air).
function makeBot(seen: Record<string, string> = {}, onChat?: (msg: string) => void) {
  const chats: string[] = [];
  return {
    chats,
    blockAt: (pos: { x: number; y: number; z: number }) => {
      const name = seen[`${pos.x},${pos.y},${pos.z}`];
      return name === undefined ? null : { type: name };
    },
    registry: {
      blocks: new Proxy(
        {},
        {
          get: (_t, type: string) => ({ name: type }),
        },
      ),
    },
    chat: (msg: string) => {
      chats.push(msg);
      onChat?.(msg);
      return Promise.resolve();
    },
  };
}

const DATA: BlueprintData = {
  levels: [
    { level: 0, coordinates: [10, 64, 10], placement: [['stone', 'dirt'], ['air', 'stone']] },
    { level: 1, coordinates: [10, 65, 10], placement: [['air']] },
  ],
};
// placement[z][x]: (10,64,10)=stone (11,64,10)=dirt (10,64,11)=air (11,64,11)=stone
const FULL_SEEN = {
  '10,64,10': 'stone',
  '11,64,10': 'dirt',
  '11,64,11': 'stone',
};

describe('Blueprint.checkLevel', () => {
  it('reports exact mismatch records with world coordinates', () => {
    const bp = new Blueprint(DATA);
    const res = bp.checkLevel(makeBot({ '10,64,10': 'stone' }), 0);
    expect(res).not.toBe(false);
    if (res === false) throw new Error('unreachable');
    expect(res.mismatches).toEqual([
      { level: 0, coordinates: [11, 64, 10], expected: 'dirt', actual: 'air' },
      { level: 0, coordinates: [11, 64, 11], expected: 'stone', actual: 'air' },
    ]);
    // air/air cells are skipped: recorded in neither list
    expect(res.matches).toEqual([
      { level: 0, coordinates: [10, 64, 10], expected: 'stone', actual: 'stone' },
    ]);
  });

  it('matches everything when the world is correct', () => {
    const bp = new Blueprint(DATA);
    const res = bp.checkLevel(makeBot(FULL_SEEN), 0);
    expect(res).not.toBe(false);
    if (res === false) throw new Error('unreachable');
    expect(res.mismatches).toEqual([]);
    expect(res.matches).toHaveLength(3);
  });

  it('returns false when the world cannot be read', () => {
    const bp = new Blueprint(DATA);
    const bot = makeBot();
    bot.blockAt = () => {
      throw new Error('chunk not loaded');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(bp.checkLevel(bot, 0)).toBe(false);
    } finally {
      err.mockRestore();
    }
  });
});

describe('Blueprint.check', () => {
  it('rejects invalid bots with an exact message', () => {
    const bp = new Blueprint(DATA);
    for (const bad of [null, undefined, 'bot', {}]) {
      expect(() => bp.check(bad)).toThrow('Invalid bot object. Expected a mineflayer bot.');
    }
  });

  it('documents the crash when blockAt is not callable', () => {
    // checkLevel swallows the TypeError into `false`; check() then crashes
    // spreading it. Pinned so any fix here is a deliberate behavior change.
    const bp = new Blueprint(DATA);
    expect(() => bp.check({ blockAt: 1 })).toThrow(TypeError);
  });

  it('aggregates matches across levels', () => {
    const bp = new Blueprint(DATA);
    const res = bp.check(makeBot(FULL_SEEN));
    expect(res.mismatches).toEqual([]);
    expect(res.matches).toHaveLength(3);
  });
});

describe('Blueprint explanations', () => {
  it('explain() pins the exact format', () => {
    expect(new Blueprint(DATA).explain()).toBe(
      'Level 0: Start at coordinates X: 10, Y: 64, Z: 10' +
        'Level 1: Start at coordinates X: 10, Y: 65, Z: 10',
    );
  });

  it('explainLevel() pins placement rendering', () => {
    expect(new Blueprint(DATA).explainLevel(0)).toBe(
      'Level 0 starting at coordinates X: 10, Y: 64, Z: 10\n' +
        '[\n[stone, dirt],\n[air, stone],\n]\n',
    );
  });

  it('says when a level is complete', () => {
    expect(new Blueprint(DATA).explainLevelDifference(makeBot(FULL_SEEN), 0)).toBe(
      'Level 0 is complete',
    );
  });

  it('tells the bot to place missing blocks', () => {
    expect(new Blueprint(DATA).explainLevelDifference(makeBot({}), 0)).toBe(
      'Level 0  requires the following fixes:\n' +
        'Place stone at coordinates X: 10, Y: 64, Z: 10\n' +
        'Place dirt at coordinates X: 11, Y: 64, Z: 10\n' +
        'Place stone at coordinates X: 11, Y: 64, Z: 11\n',
    );
  });

  it('tells the bot to remove extra blocks', () => {
    const seen = { '10,65,10': 'dirt' };
    expect(new Blueprint(DATA).explainLevelDifference(makeBot(seen), 1)).toBe(
      'Level 1  requires the following fixes:\n' +
        'Remove the dirt at coordinates X: 10, Y: 65, Z: 10\n',
    );
  });

  it('tells the bot to replace wrong blocks', () => {
    const seen = { ...FULL_SEEN, '11,64,10': 'stone' };
    expect(new Blueprint(DATA).explainLevelDifference(makeBot(seen), 0)).toBe(
      'Level 0  requires the following fixes:\n' +
        'Replace the stone with a dirt at coordinates X: 11, Y: 64, Z: 10 \n',
    );
  });

  it('explainBlueprintDifference joins every level', () => {
    const out = new Blueprint(DATA).explainBlueprintDifference(makeBot({}));
    expect(out).toContain('Level 0  requires the following fixes:');
    expect(out).toContain('Level 1 is complete');
  });
});

describe('autoBuild / autoDelete', () => {
  it('emits exact /setblock commands and a nearby position', () => {
    const { commands, nearbyPosition } = new Blueprint(DATA).autoBuild();
    // NOTE: 'air' cells intentionally still emit setblock (truthy check).
    expect(commands).toEqual([
      '/setblock 10 64 10 stone',
      '/setblock 11 64 10 dirt',
      '/setblock 10 64 11 air',
      '/setblock 11 64 11 stone',
      '/setblock 10 65 10 air',
    ]);
    expect(nearbyPosition).toEqual({ x: 16, y: 64, z: 10 });
  });

  it('autoDelete clears with air and shares the position formula', () => {
    const built = new Blueprint(DATA).autoBuild();
    const cleared = new Blueprint(DATA).autoDelete();
    expect(cleared.nearbyPosition).toEqual(built.nearbyPosition);
    expect(cleared.commands).toEqual(built.commands.map((c) => c.replace(/\S+$/, 'air')));
    expect(cleared.commands[0]).toBe('/setblock 10 64 10 air');
  });
});

describe('ConstructionTaskValidator', () => {
  const taskOf = (blueprint: unknown) => ({ blueprint }) as { blueprint: BlueprintData };

  it('scores a perfect build 100 and valid', () => {
    const v = new ConstructionTaskValidator(taskOf(DATA), { bot: makeBot(FULL_SEEN) });
    expect(v.validate()).toEqual({ valid: true, score: 100 });
  });

  it('scores partial builds by match ratio', () => {
    const v = new ConstructionTaskValidator(
      taskOf({
        levels: [{ level: 0, coordinates: [0, 0, 0], placement: [['stone', 'dirt']] }],
      }),
      { bot: makeBot({ '0,0,0': 'stone' }) },
    );
    expect(v.validate()).toEqual({ valid: false, score: 50 });
  });

  it('scores an empty blueprint 100 without dividing by zero', () => {
    const v = new ConstructionTaskValidator(
      taskOf({ levels: [{ level: 0, coordinates: [0, 0, 0], placement: [['air']] }] }),
      { bot: makeBot({}) },
    );
    expect(v.validate()).toEqual({ valid: true, score: 100 });
  });

  it('returns invalid with score 0 when checking crashes', () => {
    const v = new ConstructionTaskValidator(taskOf(null), {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(v.validate()).toEqual({ valid: false, score: 0 });
    } finally {
      err.mockRestore();
    }
  });
});

describe('resetConstructionWorld', () => {
  it('sends the exact /fill command for the blueprint bounds', () => {
    const bot = makeBot();
    resetConstructionWorld(bot, DATA);
    // width = 2+5, height = 2 levels+5, length = 2+5
    expect(bot.chats).toEqual(['/fill 10 64 10 17 71 17 air']);
  });
});

describe('checkBlueprint / checkLevelBlueprint', () => {
  const agentOf = (seen: Record<string, string> = FULL_SEEN) => ({
    task: { blueprint: new Blueprint(DATA) },
    bot: makeBot(seen),
  });

  it('confirms correct builds', () => {
    expect(checkBlueprint(agentOf())).toBe('Blueprint is correct');
    expect(checkLevelBlueprint(agentOf(), 0)).toBe('Level 0 is correct');
  });

  it('explains incorrect builds', () => {
    expect(checkBlueprint(agentOf({}))).toContain('Place stone at coordinates X: 10, Y: 64, Z: 10');
    expect(checkLevelBlueprint(agentOf({}), 0)).toContain('requires the following fixes:');
  });
});
