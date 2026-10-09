import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../apps/server/src/app.js';
import { trimAudioEnd } from '../apps/server/src/postprocess.js';
import { FakeProvider, loginAs, sampleInput, testCredentials, testWav } from '../tests/helpers.js';

const root = await mkdtemp(path.join(tmpdir(), 'chenglan-public-eval-'));
const checksum = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const results: Record<string, unknown> = { scope: 'offline fixtures; no Mureka API calls' };
let server: Awaited<ReturnType<typeof buildApp>> | undefined;

try {
  const provider = new FakeProvider();
  server = await buildApp({ root, bootstrap: testCredentials, provider });
  const auth = await loginAs(server.app);
  const submissionId = randomUUID();
  const input = sampleInput();
  const payload = { submissionId, input };
  const ids = new Set<string>();

  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await server.app.inject({ method: 'POST', url: '/api/jobs', headers: auth, payload });
    assert.equal(response.statusCode, 202);
    ids.add(response.json().id as string);
  }
  assert.equal(ids.size, 1);
  assert.equal((server.store.sqlite.prepare('SELECT count(*) AS n FROM generation_jobs').get() as { n: number }).n, 1);
  assert.equal((server.store.sqlite.prepare('SELECT count(*) AS n FROM credit_charges').get() as { n: number }).n, 1);
  assert.equal(provider.submissions, 0, 'the worker was deliberately not started');

  const changed = await server.app.inject({ method: 'POST', url: '/api/jobs', headers: auth,
    payload: { submissionId, input: { ...input, prompt: 'changed prompt' } } });
  assert.equal(changed.statusCode, 409);
  results.submitIdempotency = { repeatedRequests: 100, persistedJobs: 1, creditReservations: 1, conflictingReuseStatus: 409 };

  const source = 'eight-seconds.wav';
  const original = testWav(8);
  await writeFile(path.join(root, 'storage', source), original);
  const processed = await trimAudioEnd(source, path.join(root, 'storage'), randomUUID());
  assert.equal(processed.sourceDuration, 8000);
  assert.equal(processed.duration, 3000);
  assert.equal(checksum(await readFile(path.join(root, 'storage', source))), checksum(original));
  results.audioProcessing = { sourceMs: processed.sourceDuration, savedMs: processed.duration, removedMs: processed.sourceDuration - processed.duration, originalChecksumUnchanged: true };

  console.log(JSON.stringify(results, null, 2));
} finally {
  await server?.app.close();
  await rm(root, { recursive: true, force: true });
}
