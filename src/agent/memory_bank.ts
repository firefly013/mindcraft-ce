export class MemoryBank {
  private memory: Record<string, [number, number, number]>;

  constructor() {
    this.memory = {};
  }

  rememberPlace(name: string, x: number, y: number, z: number): void {
    this.memory[name] = [x, y, z];
  }

  recallPlace(name: string): [number, number, number] | undefined {
    return this.memory[name];
  }

  getJson(): Record<string, [number, number, number]> {
    return this.memory;
  }

  loadJson(json: Record<string, [number, number, number]>): void {
    this.memory = json;
  }

  getKeys(): string {
    return Object.keys(this.memory).join(', ');
  }
}
