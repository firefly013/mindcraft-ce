import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../src/utils/math.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('handles zero-magnitude safely (NaN like the original)', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBeNaN();
  });

  it('truncates to the shorter vector (loop bound is a.length)', () => {
    // i only runs over a: b[1] is never read, so [1] vs [1,2] scores 1.
    expect(cosineSimilarity([1], [1, 2])).toBe(1);
  });

  it('pads missing b dimensions with zero', () => {
    // i=1: b[1] is undefined -> 0. dot=1, |a|=sqrt(5), |b|=1.
    expect(cosineSimilarity([1, 2], [1])).toBeCloseTo(1 / Math.sqrt(5));
  });

  it('treats sparse holes as zero', () => {
    // holes read as undefined -> `?? 0`: dot=0, |a|=0 -> 0/0 NaN, never throws.
    // NOTE: `new Array(2)` (not a sparse literal) is intentional: it builds
    // holey input without tripping `no-sparse-arrays`.
    expect(cosineSimilarity(new Array(2), [1, 1])).toBeNaN();
  });

  it('is commutative and scale-invariant', () => {
    expect(cosineSimilarity([1, 2], [3, 4])).toBeCloseTo(cosineSimilarity([3, 4], [1, 2]));
    expect(cosineSimilarity([2, 4], [3, 4])).toBeCloseTo(cosineSimilarity([1, 2], [3, 4]));
  });
});
