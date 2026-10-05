import { describe, expect, it } from 'vitest';
import { MemoryBank } from '../src/agent/memory_bank.js';

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

  it('lists keys and handles emptiness', () => {
    expect(new MemoryBank().getKeys()).toBe('');
    const bank = new MemoryBank();
    bank.rememberPlace('a', 0, 0, 0);
    bank.rememberPlace('b', 0, 0, 0);
    expect(bank.getKeys()).toBe('a, b');
  });
});
