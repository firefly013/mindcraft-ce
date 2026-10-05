export interface NpcGoal {
  name: string;
  quantity: number;
}

export interface BuiltEntry {
  name: string;
  position: { x: number; y: number; z: number };
  orientation: number;
}

export class NPCData {
    goals: NpcGoal[];
    curr_goal: NpcGoal | null;
    built: Record<string, BuiltEntry>;
    home: string | null;
    do_routine: boolean;
    do_set_goal: boolean;

    constructor() {
        this.goals = [];
        this.curr_goal = null;
        this.built = {};
        this.home = null;
        this.do_routine = false;
        this.do_set_goal = false;
    }

    toObject(): Record<string, unknown> {
        const obj: Record<string, unknown> = {};
        if (this.goals.length > 0)
            obj.goals = this.goals;
        if (this.curr_goal)
            obj.curr_goal = this.curr_goal;
        if (Object.keys(this.built).length > 0)
            obj.built = this.built;
        if (this.home)
            obj.home = this.home;
        obj.do_routine = this.do_routine;
        obj.do_set_goal = this.do_set_goal;
        return obj;
    }

    static fromObject(obj: any): NPCData {
        const npc = new NPCData();
        if (!obj) return npc;
        if (obj.goals) {
            npc.goals = [];
            for (const goal of obj.goals as any[]) {
                if (typeof goal === 'string')
                    npc.goals.push({name: goal, quantity: 1});
                else
                    npc.goals.push({name: goal.name as string, quantity: goal.quantity as number});
            }
        }
        if (obj.curr_goal)
            npc.curr_goal = obj.curr_goal as NpcGoal;
        if (obj.built)
            npc.built = obj.built as Record<string, BuiltEntry>;
        if (obj.home)
            npc.home = obj.home as string;
        if (obj.do_routine !== undefined)
            npc.do_routine = obj.do_routine as boolean;
        if (obj.do_set_goal !== undefined)
            npc.do_set_goal = obj.do_set_goal as boolean;
        return npc;
    }
}
