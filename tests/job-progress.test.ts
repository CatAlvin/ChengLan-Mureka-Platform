import { describe, it, expect } from 'vitest';
import { jobProgress, jobInProgress } from '../apps/web/src/lib/job-progress';
import { sampleJob } from './helpers';
describe('generation and saving progress', () => {
  it('keeps a generated song pending until every output is saved', () => {
    const job=sampleJob({status:'succeeded'});
    expect(jobProgress(job,[])).toBe('saving_audio');
    expect(jobProgress(job,[{jobId:job.id,saveStatus:'saved'},{jobId:job.id,saveStatus:'saving'}])).toBe('saving_audio');
    expect(jobInProgress(job,[{jobId:job.id,saveStatus:'saving'}])).toBe(true);
    expect(jobProgress(job,[{jobId:job.id,saveStatus:'saved'}])).toBe('succeeded');
  });
  it('puts failed audio saves in needs-attention, regardless of other outputs', () => {
    const job=sampleJob({status:'succeeded'});
    const tracks=[{jobId:job.id,saveStatus:'save_failed' as const},{jobId:job.id,saveStatus:'saved' as const}];
    expect(jobProgress(job,tracks)).toBe('audio_save_failed');expect(jobInProgress(job,tracks)).toBe(false);
    expect(jobProgress(job,[{jobId:'someone-else',saveStatus:'save_failed'}])).toBe('saving_audio');
  });
  it('preserves lyric completion and upstream failure states', () => {
    expect(jobProgress(sampleJob({status:'succeeded',kind:'lyrics'}),[])).toBe('succeeded');
    expect(jobProgress(sampleJob({status:'succeeded',kind:'lyrics_extend'}),[])).toBe('succeeded');
    expect(jobProgress(sampleJob({status:'failed'}),[])).toBe('failed');
  });
});
