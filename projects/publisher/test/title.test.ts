import { describe, expect, it } from 'vitest';
import { expectedArticleTitle, titlesMatch } from '../src/domain/title.js';

describe('article title logic', () => {
  it('renders padded and unpadded day placeholders', () => {
    expect(expectedArticleTitle('Day {day2} / 第 {day} 天', 3)).toBe('Day 03 / 第 3 天');
  });

  it('normalizes Unicode width and whitespace without allowing fuzzy matches', () => {
    expect(titlesMatch('Ｄａｙ ０３  -  Reliable', 'Day 03 - Reliable')).toBe(true);
    expect(titlesMatch('Day 03 - Reliable!', 'Day 03 - Reliable')).toBe(false);
  });
});
