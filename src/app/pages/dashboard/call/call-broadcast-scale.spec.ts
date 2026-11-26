import { BroadcastScale, clampBroadcastScale } from './call-broadcast-scale';

describe('BroadcastScale', () => {
  beforeEach(() => localStorage.clear());

  it('clamps to 25–100 %', () => {
    expect(clampBroadcastScale(0.1)).toBe(0.25);
    expect(clampBroadcastScale(3)).toBe(1);
    expect(clampBroadcastScale(Number.NaN)).toBe(1);
    expect(clampBroadcastScale(0.567)).toBe(0.57);
  });

  it('starts full size and remembers the size per kind', () => {
    const image = new BroadcastScale('image');
    expect(image.value).toBe(1);
    image.shrink();
    image.shrink();
    expect(image.percent).toBe(80);

    expect(new BroadcastScale('image').percent).toBe(80);
    expect(new BroadcastScale('video').percent).toBe(100);
  });

  it('grows, resets and stops at the edges', () => {
    const video = new BroadcastScale('video');
    video.set(0.3);
    video.shrink();
    expect(video.value).toBe(0.25);
    expect(video.canShrink).toBe(false);
    video.reset();
    expect(video.value).toBe(1);
    expect(video.canGrow).toBe(false);
  });

  it('keys on the handle change the size', () => {
    const image = new BroadcastScale('image');
    const key = (k: string) => image.onHandleKeydown(new KeyboardEvent('keydown', { key: k }));
    key('ArrowDown');
    expect(image.percent).toBe(90);
    key('ArrowUp');
    expect(image.percent).toBe(100);
    key('-');
    key('Home');
    expect(image.percent).toBe(100);
  });
});
