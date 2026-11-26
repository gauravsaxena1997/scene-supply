import {execFile} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {resolve, relative} from 'node:path';
import {getCredential} from './config.js';
import {hash, projectPath} from './project.js';

const run = promisify(execFile);
const paid = new Set(['starter', 'creator', 'pro', 'scale', 'business', 'enterprise']);

async function request(path, key, body) {
  const response = await fetch('https://api.elevenlabs.io/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {'xi-api-key': key, ...(body ? {'content-type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error('ElevenLabs request failed with HTTP ' + response.status);
  return response;
}

export async function narrationStatus() {
  const key = await getCredential('elevenlabs');
  if (!key) return {configured: false, commercialPlan: false};
  const account = await (await request('user/subscription', key)).json();
  return {configured: true, tier: account.tier, billingStatus: account.status, commercialPlan: paid.has(account.tier) && account.status === 'active', creditsUsed: account.character_count, creditsLimit: account.character_limit};
}

export async function produceNarration(root, atom, directory, intendedUse) {
  const key = await getCredential('elevenlabs');
  if (!key) throw new Error('Configure the user-level ElevenLabs credential first');
  await run('ffprobe', ['-version']);
  const fingerprint = hash(JSON.stringify([atom.text, atom.voiceId, atom.modelId, intendedUse]));
  const path = await projectPath(root, relative(root, resolve(directory, fingerprint + '.mp3')));
  const receipt = await projectPath(root, relative(root, path + '.json'));
  let record;
  try {
    record = JSON.parse(await readFile(receipt, 'utf8'));
    if (record.fingerprint !== fingerprint || record.intendedUse !== intendedUse) throw new Error('Narration receipt mismatch');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const account = await narrationStatus();
    if (intendedUse === 'commercial' && !account.commercialPlan) throw new Error('ElevenLabs account does not report an active paid plan for commercial generation');
    // A file without its receipt can be recovered manually. Do not charge twice.
    if (await readFile(path).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;})) throw new Error('Narration exists without a receipt; inspect it before retrying');
    const response = await request('text-to-speech/' + encodeURIComponent(atom.voiceId) + '?output_format=mp3_44100_128', key, {text: atom.text, model_id: atom.modelId});
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('ElevenLabs returned empty audio');
    record = {fingerprint, intendedUse, tier: account.tier, modelId: atom.modelId, voiceId: atom.voiceId, requestId: response.headers.get('request-id'), credits: response.headers.get('character-cost')};
    await writeFile(path, bytes, {flag: 'wx'});
    await writeFile(receipt, JSON.stringify(record, null, 2) + '\n', {flag: 'wx'});
  }
  const {stdout} = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path]);
  const metadata = JSON.parse(stdout);
  const seconds = Number(metadata.format?.duration);
  if (metadata.streams?.[0]?.codec_type !== 'audio' || !Number.isFinite(seconds) || seconds <= 0) throw new Error('Could not measure the narration asset');
  return {
    path: relative(root, path), mediaType: 'audio', durationSeconds: seconds,
    provenance: {provider: 'elevenlabs', ...(record.requestId ? {providerId: record.requestId} : {}), sidecarPath: relative(root, receipt), rightsStatus: 'review-required', notes: 'Synthesized for ' + intendedUse + '; check model, voice and intended-use terms before release.'},
  };
}
