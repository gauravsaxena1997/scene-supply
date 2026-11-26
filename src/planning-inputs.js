import {readFile} from 'node:fs/promises';
import {fileMetadata, hash, projectPath, readProjectContext, scriptDocument} from './project.js';
import {planningChecksSchema, transcriptSchema} from './schemas.js';

export async function planningInputs(root, {checksFile, transcriptPath} = {}) {
  const context = await readProjectContext(root, checksFile);
  const rules = context.guidance.find(file => file.path === context.personalizationFile);
  const checks = planningChecksSchema.parse(rules ? JSON.parse(rules.content).planningChecks ?? {} : {});
  if (!transcriptPath) return {context, checks, rules};
  const raw = await readFile(await projectPath(root, transcriptPath, true), 'utf8');
  const transcript = transcriptSchema.parse(JSON.parse(raw));
  const audio = await fileMetadata(await projectPath(root, transcript.audioPath, true));
  if (audio.sha256 !== transcript.audioSha256) throw new Error('Transcript audio hash differs from the source take');
  const ids = new Set();
  let previousStart = 0;
  for (const sentence of transcript.sentences) {
    if (ids.has(sentence.id)) throw new Error(`Duplicate transcript sentence ${sentence.id}`);
    ids.add(sentence.id);
    for (const word of sentence.words) {
      if (word.startSeconds < previousStart || word.endSeconds <= word.startSeconds) {
        throw new Error(`Invalid word timing in ${sentence.id}: ${word.text}`);
      }
      previousStart = word.startSeconds;
    }
  }
  return {context, checks, rules, transcript, transcriptRef: {path: transcriptPath, sha256: hash(raw)}};
}

export function transcriptScript(transcript) {
  const text = transcript.sentences.map(sentence => sentence.words.map(word => word.text).join(' ')).join('\n\n');
  const script = scriptDocument(text);
  script.segments = transcript.sentences.map(sentence => {
    const words = sentence.words.map(word => word.text);
    return {id: sentence.id, text: words.join(' '), words};
  });
  return script;
}

export function checkPlanningInputs(plan, inputs, ranges) {
  const errors = [];
  const fail = (code, message) => errors.push({code, message});
  const {checks, rules, transcript, transcriptRef} = inputs;
  if (rules && !plan.project.guidance.some(file => file.path === rules.path && file.sha256 === rules.sha256)) {
    fail('stale_project_checks', 'Refresh the saved plan against the current project test file.');
  }
  const limit = checks.maxCompositionSeconds;
  if (limit) {
    let previous;
    let seconds = 0;
    for (const shot of plan.shots) {
      if (!shot.compositionId) fail('missing_composition_id', shot.id);
      const composition = shot.compositionId ?? shot.primaryAtomId;
      seconds = previous === composition ? seconds + shot.durationSeconds : shot.durationSeconds;
      if (seconds > limit + 1e-6) fail('composition_hold', `${composition} through ${shot.id}: ${seconds.toFixed(2)}s exceeds ${limit}s`);
      previous = composition;
    }
  }
  if (checks.requireReviewedTranscript && plan.timingBasis === 'aligned' && !transcript) {
    fail('missing_reviewed_transcript', 'An aligned narrated plan requires a reviewed transcript of the source take.');
  }
  if (plan.transcript && plan.transcript.sha256 !== transcriptRef?.sha256) {
    fail('stale_transcript', 'The reviewed transcript changed. Revise the plan against the new timing.');
  }

  const fps = plan.edit?.fps;
  const narration = plan.edit?.audio.filter(cue => cue.role === 'narration') ?? [];
  if (transcript && plan.timingBasis === 'aligned' && !plan.shots.some(shot => shot.speechAnchor)) {
    fail('missing_speech_anchors', 'Anchor at least one visual cut to a reviewed word.');
  }
  if (transcript && plan.timingBasis === 'aligned' && !narration.length) {
    fail('missing_narration_placement', 'Place the reviewed take on the edit timeline.');
  }
  if (transcript) {
    for (const cue of narration) {
      const asset = plan.assets[cue.atomId];
      if (asset && asset.sha256 !== transcript.audioSha256) fail('narration_take_mismatch', cue.id);
    }
  }
  const checkAnchor = (anchor, frame, id) => {
    if (!anchor) return;
    const word = transcript?.sentences.find(sentence => sentence.id === anchor.sentenceId)?.words[anchor.wordIndex];
    if (!word || !fps) { fail('invalid_speech_anchor', id); return; }
    const sourceSeconds = anchor.edge === 'end' ? word.endSeconds : word.startSeconds;
    const candidates = narration.map(cue => ({
      cue, frame: cue.startFrame + Math.round((sourceSeconds - cue.sourceInSeconds) * fps),
    })).filter(item => item.frame >= item.cue.startFrame &&
      (item.frame < item.cue.endFrame || anchor.edge === 'end' && item.frame === item.cue.endFrame));
    if (candidates.length !== 1 || candidates[0].frame + anchor.offsetFrames !== frame) fail('speech_anchor_frame_mismatch', id);
  };
  plan.shots.forEach((shot, index) => {
    const start = ranges[index]?.startFrame;
    checkAnchor(shot.speechAnchor, start, shot.id);
    for (const keyframe of shot.motion.keyframes) {
      checkAnchor(keyframe.speechAnchor, start + Math.round(keyframe.offsetSeconds * fps), shot.id);
    }
  });
  for (const cue of plan.captionCues) {
    checkAnchor(cue.startAnchor, Math.round(cue.startSeconds * fps), cue.id);
    checkAnchor(cue.endAnchor, Math.round(cue.endSeconds * fps), cue.id);
  }
  for (const action of plan.edit?.actions ?? []) checkAnchor(action.speechAnchor, action.frame, action.id);
  return errors;
}
