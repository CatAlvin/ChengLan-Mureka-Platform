import { describe, it, expect } from 'vitest';
import { creationModel, emptyDraft, generationSchema, toMurekaBody } from '../packages/shared/src/index.js';
import { publicAddress, validateMediaUrl } from '../apps/server/src/media.js';
import { songTaskSchema, errorText } from '../apps/server/src/provider.js';

describe('Mureka request contract', () => {
  it('requires a real idea and counts all prompt preferences against the limit', () => {
    expect(generationSchema.safeParse(emptyDraft('easy')).success).toBe(false);
    expect(generationSchema.safeParse({ ...emptyDraft('easy'), prompt: '歌'.repeat(2000), mood: '安静舒缓' }).success).toBe(false);
    expect(generationSchema.safeParse({ ...emptyDraft('instrumental'), prompt: '曲'.repeat(1024) }).success).toBe(true);
  });
  it('maps easy, custom lyrics and instrumental without unsupported controls', () => {
    const easy = toMurekaBody({ ...emptyDraft('easy'), prompt: '夏天', styles: ['folk'] });
    expect(easy).toEqual({ model: 'mureka-9.5', n: 1, prompt: '夏天；中文歌词', stream: false, styles: ['folk'] });
    const instrumental = toMurekaBody({ ...emptyDraft('instrumental'), prompt: '雨夜', styles: ['ambient'], gender: 'female' });
    expect(instrumental).toEqual({ model: 'mureka-9.5', n: 1, prompt: '雨夜；ambient', stream: false });
    expect(generationSchema.safeParse({ ...emptyDraft('lyrics'), model: 'mureka-9.5', lyrics: '海风' }).success).toBe(true);
    const custom = { ...emptyDraft('lyrics'), lyrics: '[Verse]\n海风', gender: 'female' as const };
    expect(generationSchema.safeParse(custom).success).toBe(true);
    expect(toMurekaBody(custom)).toHaveProperty('gender', 'female');
    expect(creationModel({ ...custom, model: 'mureka-9.5', source: { assetId: '123', kind: 'melody', start: 0, end: 5000 } })).toBe('mureka-8');
    expect(generationSchema.safeParse({ ...custom, lyrics: '歌'.repeat(5001) }).success).toBe(false);
  });
  it('recognizes reviewing and the provider spelling timeouted', () => {
    expect(songTaskSchema.parse({ id: 123, status: 'reviewing' }).id).toBe('123');
    expect(songTaskSchema.parse({ id: 'a', status: 'timeouted' }).status).toBe('timeouted');
  });
  it('returns useful errors without reflecting upstream secret-bearing text', () => {
    expect(errorText(429, 'quota exhausted')).toContain('额度不足');
    expect(errorText(429, 'rate limit')).toContain('请求较多');
    expect(errorText(500, 'private-secret')).not.toContain('private-secret');
  });
});

describe('media network boundary', () => {
  it.each(['https://127.0.0.1/a', 'https://10.0.0.1/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'https://169.254.169.254/a', 'http://example.com/a', 'https://user:pass@example.com/a', 'https://example.com:444/a', 'https://localhost/a'])('rejects %s', url => {
    expect(() => validateMediaUrl(url)).toThrow();
  });
  it('accepts public HTTPS while rejecting private DNS answers', () => {
    expect(validateMediaUrl('https://cdn.example.com/music.mp3').hostname).toBe('cdn.example.com');
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('192.168.1.2')).toBe(false);
    expect(publicAddress('fc00::1')).toBe(false);
  });
});
