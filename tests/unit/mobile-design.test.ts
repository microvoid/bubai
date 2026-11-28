import { expect, test } from 'bun:test';
import { buzzMessageLayout, buzzTypography, getBuzzAccent } from '../../packages/design-tokens/src';

test('an unknown saved accent falls back to the neutral palette and explicit colors still apply', () => {
  for (const mode of ['light', 'dark'] as const) {
    expect(getBuzzAccent('retired-accent', mode)).toEqual(getBuzzAccent('neutral', mode));
    expect(getBuzzAccent('Chartreuse', mode)).not.toEqual(getBuzzAccent('neutral', mode));
  }
  expect(getBuzzAccent('neutral', 'light').fill).toBe('#262626');
});

test('message metrics match the Buzz mobile reference', () => {
  expect(buzzTypography.message).toMatchObject({fontSize: 17, lineHeight: 23, letterSpacing: -0.45});
  expect(buzzTypography.timestamp).toEqual({fontSize: 13.1, lineHeight: 17});
  expect(buzzMessageLayout).toEqual({avatar: 36, avatarGap: 12, insetX: 14, insetY: 10, widthFraction: 2 / 3});
});
