import { describe, expect, it } from 'vitest';
import { SCAN_MAX_PORT, scanPorts } from '../src/brain/mindserver/mcserver.js';

describe('scanPorts', () => {
  it('从中心向两侧展开', () => {
    expect([...scanPorts(10, 14, 12)]).toEqual([12, 13, 11, 14, 10]);
  });

  it('中心越界时夹到范围内', () => {
    expect([...scanPorts(10, 12, 99)]).toEqual([12, 11, 10]);
  });

  it('覆盖整个范围且不重复', () => {
    const ports = [...scanPorts(10, 20, 15)];
    expect(ports).toHaveLength(11);
    expect(new Set(ports).size).toBe(11);
    expect([...ports].sort((a, b) => a - b)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it('扫描上限不超过 TCP 端口上限', () => {
    expect(SCAN_MAX_PORT).toBeLessThanOrEqual(65_535);
  });
});
