import { describe, expect, it } from 'vitest';
import { MemoryBank } from '../src/body/memory_bank.js';

describe('MemoryBank', () => {
  it('remembers and recalls places', () => {
    const bank = new MemoryBank();
    bank.rememberPlace('home', 1, 2, 3);
    expect(bank.recallPlace('home')).toEqual([1, 2, 3]);
  });

  it('returns undefined for unknown places', () => {
    expect(new MemoryBank().recallPlace('nowhere')).toBeUndefined();
  });

  it('overwrites a place on re-remember', () => {
    const bank = new MemoryBank();
    bank.rememberPlace('home', 1, 2, 3);
    bank.rememberPlace('home', 9, 9, 9);
    expect(bank.recallPlace('home')).toEqual([9, 9, 9]);
  });

  it('loadJson replaces (not merges) memory', () => {
    const bank = new MemoryBank();
    bank.rememberPlace('stale', 1, 1, 1);
    bank.loadJson({ fresh: [2, 2, 2] });
    expect(bank.recallPlace('stale')).toBeUndefined();
    expect(bank.recallPlace('fresh')).toEqual([2, 2, 2]);
  });

  it('round-trips JSON', () => {
    const bank = new MemoryBank();
    bank.rememberPlace('a', 1, 2, 3);
    bank.rememberPlace('b', 4, 5, 6);
    const other = new MemoryBank();
    other.loadJson(bank.getJson());
    expect(other.recallPlace('b')).toEqual([4, 5, 6]);
  });

  it('列出地点时**带坐标**：只有一串名字，模型还是不知道它在哪', () => {
    expect(new MemoryBank().getKeys()).toBe('（一个都没记住）');
    const bank = new MemoryBank();
    bank.rememberPlace('铁矿洞', -40.51, 51, 7.25);
    const listed = bank.getKeys();
    expect(listed).toContain('铁矿洞');
    expect(listed).toContain('-40.5');
  });
});

/**
 * 身体侧这份**不落盘**——这是有意的：跨重启要留的东西归大脑侧会话管
 * （`PlacesDoc`），这里只装死亡位置这类瞬时信息。留两份真源正是
 * "存完列不出来"（Feedback #6）的成因，所以这里明确锁住"它不碰磁盘"。
 */
describe('MemoryBank：身体侧不持有跨重启的地点', () => {
  it('纯内存：不落盘、也不读盘', () => {
    const bank = new MemoryBank();
    bank.rememberPlace('last_death_position', 1, 2, 3);
    expect(bank.recallPlace('last_death_position')).toEqual([1, 2, 3]);
  });

  it('列出时带坐标', () => {
    const bank = new MemoryBank();
    bank.rememberPlace('last_death_position', -40.51, 51, 7.25);
    const listed = bank.getKeys();
    expect(listed).toContain('last_death_position');
    expect(listed).toContain('-40.5');
  });

  it('一个都没记住时明说', () => {
    expect(new MemoryBank().getKeys()).toBe('（一个都没记住）');
  });
});
