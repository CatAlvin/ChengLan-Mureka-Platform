import { terminalStatuses, type Job, type Track } from '../../../../packages/shared/src/index';

// Provider completion and a playable, saved file are separate milestones.
export function jobProgress(job: Job, tracks: Pick<Track, 'jobId' | 'saveStatus'>[] = []): Job['status'] | 'saving_audio' | 'audio_save_failed' {
  if (job.status !== 'succeeded' || ['lyrics', 'lyrics_extend', 'recognize', 'describe', 'transcribe'].includes(job.kind)) return job.status;
  const outputs = tracks.filter(track => track.jobId === job.id);
  if (outputs.some(track => track.saveStatus === 'save_failed')) return 'audio_save_failed';
  if (!outputs.length || outputs.some(track => track.saveStatus === 'saving')) return 'saving_audio';
  return 'succeeded';
}
export function jobInProgress(job: Job, tracks: Pick<Track, 'jobId' | 'saveStatus'>[]) {
  const status = jobProgress(job, tracks);
  return status !== 'audio_save_failed' && !terminalStatuses.includes(status);
}
