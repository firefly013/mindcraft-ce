/**
 * 身体侧的**本地**位置账——只留身体自己要用的（比如死亡位置）。
 *
 * ⚠️ **模型记住的地名不在这里。** 那些的真源是大脑侧会话里的 `PlacesDoc`
 * （经 `stateAccess` 读写），`getPlaces` / `rememberHere` / `goToRememberedPlace`
 * 三个工具住在大脑侧。以前这份东西两边各存一份，于是有了经典的两个真源：
 * 身体重启就丢、大脑那份一直空着，模型存完列不出来（Feedback #6）。
 *
 * 它**不落盘**：身体进程重启就清空，而它装的都是"上一次死亡位置"这类丢了也
 * 无所谓的瞬时信息。真要跨重启的走大脑侧——那边的会话是续的。
 */
export type PlaceCoords = [number, number, number];

export class MemoryBank {
  private memory: Record<string, PlaceCoords> = {};

  rememberPlace(name: string, x: number, y: number, z: number): void {
    this.memory[name] = [x, y, z];
  }

  recallPlace(name: string): PlaceCoords | undefined {
    return this.memory[name];
  }

  getJson(): Record<string, PlaceCoords> {
    return this.memory;
  }

  loadJson(json: Record<string, PlaceCoords>): void {
    this.memory = json;
  }

  /** 给人看的清单：**名字 + 坐标**——只有一串名字，模型还是不知道它在哪。 */
  getKeys(): string {
    const entries = Object.entries(this.memory);
    if (entries.length === 0) return '（一个都没记住）';
    return entries.map(([name, [x, y, z]]) => `${name}(${r(x)},${r(y)},${r(z)})`).join('、');
  }
}

/** 坐标取整：模型不需要浮点噪音。 */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}
