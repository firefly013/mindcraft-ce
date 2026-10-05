/**
 * Baritone 包加载器：真包动态 import 不炸，attach 可调用。
 * 包体大，这个文件单独跑，不拖全仓速度也心里有数。
 */
import { describe, expect, it } from 'vitest';
import { defaultBaritoneDir, loadBaritonePackage } from '../src/agent/baritone_loader.js';

describe('baritone_loader', () => {
  it('resolves the sibling package directory by default', () => {
    expect(defaultBaritoneDir().endsWith('mineflayer-baritone')).toBe(true);
  });

  it('loads the real package and exposes attach', async () => {
    const pkg = await loadBaritonePackage();
    expect(typeof pkg.attach).toBe('function');
  }, 30000);

  it('rejects a bogus directory with a clear error', async () => {
    await expect(loadBaritonePackage('C:/no/such/dir')).rejects.toThrow();
  });
});
