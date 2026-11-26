import {readFile, writeFile, mkdir, rename, rm, copyFile} from 'node:fs/promises';
import {resolve, dirname, basename, relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {draftSchema, planSchema, assetSchema, getSchemas, ATOM_TYPES} from './schemas.js';
import {projectPath, readKnowledge, scriptDocument, fileMetadata} from './project.js';
import {credentialStatus} from './config.js';
import {searchStock, downloadStock} from './stock.js';
import {COMPONENT_SOURCES} from './components.js';
import {planningInputs, checkPlanningInputs, transcriptScript} from './planning-inputs.js';
import {produceNarration} from './narration.js';

const relativeFile = (root, file) => relative(root, file).split('\\').join('/');
const dependencies = atom => atom.referenceAtomIds || [];
const usedAtoms = plan => {
  const ids = new Set();
  const visit = id => { if (ids.has(id)) return; ids.add(id); const atom = plan.atoms.find(a => a.id === id); if (atom) dependencies(atom).forEach(visit); };
  for (const cue of plan.edit?.audio || []) visit(cue.atomId);
  plan.shots.forEach(shot => { visit(shot.primaryAtomId); shot.annotations.forEach(item => { if (item.atomId) visit(item.atomId); }); });
  return ids;
};

async function loadPlan(file) {
  const absolute = resolve(file);
  return {file: absolute, root: dirname(absolute), plan: planSchema.parse(JSON.parse(await readFile(absolute, 'utf8')))};
}

async function locked(file, operation) {
  const lock = `${resolve(file)}.lock`;
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error(`Plan is being updated: ${lock}. Remove a stale lock only after confirming no producer is active.`); throw error; }
  try { return await operation(); } finally { await rm(lock, {recursive: true, force: true}); }
}

async function savePlan(file, plan, previous) {
  plan.updatedAt = new Date().toISOString();
  plan.revision = previous.revision + 1;
  planSchema.parse(plan);
  const history = await projectPath(dirname(file), `.scenesupply/history/${basename(file)}`);
  await mkdir(history, {recursive: true});
  await writeFile(resolve(history, `${previous.revision}-${randomUUID()}.json`), JSON.stringify(previous, null, 2) + '\n', {flag: 'wx'});
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(plan, null, 2) + '\n', {flag: 'wx'}); await rename(temporary, file); }
  finally { await rm(temporary, {force: true}); }
}

export async function sourceStatus() {
  const credentials = await credentialStatus();
  const ltx = await ltxConfig();
  return {
    stock: Object.fromEntries(['pexels', 'pixabay', 'coverr'].map(provider => [provider, {credential: credentials[provider], configured: credentials[provider] !== 'missing', health: 'not_probed', types: provider === 'coverr' ? ['video'] : ['image', 'video']} ])),
    componentSources: Object.fromEntries(Object.entries(COMPONENT_SOURCES).map(([name, source]) => [name, {homepage: source.homepage, access: source.access, health: 'not_probed'}])),
    imageGeneration: {provider: 'chatgpt_imagegen', execution: 'agent_tool', health: 'agent_must_confirm_tool_exposure'},
    ltx: {provider: 'local_ltx_2_5', execution: ltx ? 'command_adapter' : 'agent_handoff', configured: Boolean(ltx), health: 'not_probed'},
    googleFlow: {execution: 'agent_browser_handoff', health: 'agent_must_confirm_session'},
    narration: {provider: 'elevenlabs', credential: credentials.elevenlabs, execution: 'explicit_api_opt_in'},
    remotion: {supported: false, manifestSupported: true, renderExecution: 'project_composition'},
    webSearch: {execution: 'agent_tool'},
  };
}

export async function planVisuals({projectDir, scriptPath, script, draft, output = 'visual-plan.json', composition, automatic = false, resolvedStyles, allowGenericStyle = false, transcriptPath, checksFile}) {
  if (script == null && !scriptPath && !transcriptPath) throw new Error('Provide script text, a project-relative scriptPath, or transcriptPath');
  const {context, checks, transcript, transcriptRef} = await planningInputs(projectDir, {checksFile, transcriptPath});
  const document = transcript ? transcriptScript(transcript) : scriptDocument(script ?? await readFile(await projectPath(context.root, scriptPath, true), 'utf8'));
  const requested = composition || context.config.composition;
  const brief = {
    status: !requested && !automatic ? 'needs_composition' : 'needs_creative_plan',
    project: {allowedAtoms: context.config.allowedAtoms, guidance: context.guidance, styles: context.config.styles, narrator: context.config.narrator},
    script: document, transcript, checks, composition: requested || {mode: 'automatic'},
    compositionOrigin: composition ? 'user' : context.config.composition ? 'channel' : automatic ? 'user_authorized_automatic' : 'missing',
    warnings: context.warnings, knowledge: await readKnowledge(), draftSchema: getSchemas().draft,
    nextAction: !requested && !automatic ? 'Ask for a composition or permission to choose it. Do not save an invented plan.' : 'Agent creates shot decisions using this brief, then calls plan again with draft. Saving does not produce assets.',
  };
  if (!draft) return brief;
  if (!requested && !automatic) throw new Error('Composition is missing; provide targets or authorize automatic selection');
  if (!context.guidance.length && !Object.keys(resolvedStyles || context.config.styles).length && !allowGenericStyle) throw new Error('No brand guidance or styles supplied; explicitly authorize generic styling with allowGenericStyle');
  const parsed = draftSchema.parse(draft);
  if (requested && JSON.stringify(parsed.composition.targets) !== JSON.stringify(requested.targets)) {
    const keys = new Set([...Object.keys(parsed.composition.targets), ...Object.keys(requested.targets)]);
    if ([...keys].some(key => (parsed.composition.targets[key] || 0) !== (requested.targets[key] || 0))) throw new Error('Draft composition does not match the requested composition');
  }
  parsed.composition = requested ? {...requested, measurement: 'primary_visual_duration', tolerancePercentagePoints: requested.tolerancePercentagePoints ?? 5} : parsed.composition;
  if (!requested && parsed.composition.mode !== 'automatic') throw new Error('Automatically chosen composition must use automatic mode');
  const now = new Date().toISOString();
  const plan = planSchema.parse({...parsed, transcript: transcriptRef, checksFile, schemaVersion: '1.0', revision: 1, status: 'planned', createdAt: now, updatedAt: now, project: {root: '.', ...brief.project, styles: resolvedStyles || brief.project.styles}, script: document, assets: {}, production: {}});
  const report = await validateDocument(plan, context.root);
  if (report.errors.length) throw new Error(`Invalid plan: ${JSON.stringify(report.errors)}`);
  // Store at project root so every relative asset path has one stable base.
  if (basename(output) !== output) throw new Error('Plan output must be a filename in the project root');
  const file = await projectPath(context.root, output);
  await writeFile(file, JSON.stringify(plan, null, 2) + '\n', {flag: 'wx'});
  return {status: 'planned', file, revision: plan.revision, validation: report};
}

async function validateDocument(plan, root) {
  const errors = [], pending = [], warnings = [];
  try {
    const inputs = await planningInputs(root, {checksFile: plan.checksFile, transcriptPath: plan.transcript?.path});
    errors.push(...checkPlanningInputs(plan, inputs, plan.edit ? frameRanges(plan) : []));
  } catch (error) { errors.push({code: 'planning_input', message: error.message}); }
  const atoms = new Map(), shots = new Set(), cues = new Set();
  const add = (list, code, message) => list.push({code, message});
  for (const atom of plan.atoms) {
    if (atoms.has(atom.id)) add(errors, 'duplicate_atom', atom.id);
    atoms.set(atom.id, atom);
    if (!plan.project.allowedAtoms.includes(atom.type)) add(errors, 'prohibited_atom', atom.id);
    if (atom.type === 'stock_image' && (atom.providers.includes('coverr') || atom.selection?.provider === 'coverr')) add(errors, 'coverr_image', atom.id);
    if (atom.selection && (!atom.providers.includes(atom.selection.provider) || atom.selection.type !== (atom.type === 'stock_image' ? 'image' : 'video'))) add(errors, 'invalid_selection', atom.id);
    if (atom.type === 'generated_video') {
      if (atom.provider === 'local_ltx_2_5' && (atom.flow || atom.durationSeconds < 3 || atom.durationSeconds > 8)) add(errors, 'invalid_ltx_intent', atom.id);
      if (atom.provider === 'google_flow' && (!atom.flow || (atom.flow.purpose === 'spoken_dialogue') !== Boolean(atom.flow.dialogue))) add(errors, 'invalid_flow_intent', atom.id);
    }
    if (atom.brandRuleRefs.some(ref => !ref.trim())) add(errors, 'empty_brand_reference', atom.id);
  }
  const visiting = new Set(), visited = new Set();
  const visit = atom => {
    if (visiting.has(atom.id)) { add(errors, 'dependency_cycle', atom.id); return; }
    if (visited.has(atom.id)) return;
    visiting.add(atom.id);
    for (const dep of dependencies(atom)) {
      const target = atoms.get(dep);
      if (!target) add(errors, 'missing_dependency', `${atom.id}: ${dep}`);
      else { if (!['generated_image', 'stock_image', 'provided_media', 'source_evidence'].includes(target.type) || target.type === 'provided_media' && target.mediaType !== 'image' || target.type === 'source_evidence' && target.capture === 'recording') add(errors, 'invalid_image_dependency', `${atom.id}: ${dep}`); visit(target); }
    }
    visiting.delete(atom.id); visited.add(atom.id);
  };
  plan.atoms.forEach(visit);
  const coverage = new Map(plan.script.segments.map(segment => [segment.id, new Array(segment.words.length).fill(0)]));
  const durationByType = Object.fromEntries(ATOM_TYPES.map(type => [type, 0]));
  let total = 0;
  let lastSegment = -1, lastWord = 0;
  for (const cue of plan.captionCues) {
    if (cues.has(cue.id)) add(errors, 'duplicate_caption', cue.id);
    cues.add(cue.id);
    if (cue.endSeconds <= cue.startSeconds) add(errors, 'caption_timing', cue.id);
  }
  for (const shot of plan.shots) {
    if (shots.has(shot.id)) add(errors, 'duplicate_shot', shot.id);
    shots.add(shot.id);
    const segment = plan.script.segments.find(item => item.id === shot.scriptSpan.segmentId);
    const span = shot.scriptSpan;
    if (!segment || span.endWordExclusive > segment.words.length || span.endWordExclusive <= span.startWord) add(errors, 'invalid_script_span', shot.id);
    else {
      const index = plan.script.segments.indexOf(segment);
      if (index < lastSegment || index === lastSegment && span.startWord < lastWord) add(errors, 'script_order', shot.id);
      lastSegment = index; lastWord = span.endWordExclusive;
      if (segment.words.slice(span.startWord, span.endWordExclusive).join(' ') !== span.text.trim().split(/\s+/).join(' ')) add(errors, 'script_text_mismatch', shot.id);
      for (let i = span.startWord; i < span.endWordExclusive; i++) coverage.get(segment.id)[i]++;
    }
    const atom = atoms.get(shot.primaryAtomId);
    if (!atom) add(errors, 'missing_primary_atom', shot.id);
    else {
      if (atom.type === 'narration' || atom.type === 'provided_media' && atom.mediaType === 'audio') add(errors, 'audio_primary_visual', shot.id);
      durationByType[atom.type] += shot.durationSeconds;
      if (atom.type === 'generated_video' && atom.provider === 'local_ltx_2_5' && shot.durationSeconds > atom.durationSeconds) add(errors, 'generated_clip_too_short', shot.id);
      if (['stock_video', 'generated_video'].includes(atom.type) || atom.type === 'provided_media' && atom.mediaType === 'video' || atom.type === 'source_evidence' && atom.capture === 'recording') {
        if (!shot.playback) add(pending, 'missing_trim', shot.id);
      }
    }
    if (shot.playback) {
      const p = shot.playback;
      if (p.sourceOutSeconds <= p.sourceInSeconds || Math.abs((p.sourceOutSeconds - p.sourceInSeconds) / p.speed - shot.durationSeconds) > 0.05) add(errors, 'trim_duration_mismatch', shot.id);
      const duration = plan.assets[shot.primaryAtomId]?.durationSeconds;
      if (atom?.type === 'generated_video' && atom.provider === 'google_flow' && (atom.flow?.purpose === 'spoken_dialogue') !== (p.audio === 'original')) add(errors, 'flow_audio_mode', shot.id);
      if (duration && p.sourceOutSeconds > duration + 0.05) add(errors, 'trim_outside_asset', shot.id);
    }
    if (shot.motion.keyframes.some(frame => frame.offsetSeconds > shot.durationSeconds)) add(errors, 'motion_outside_shot', shot.id);
    const annotationIds = new Set();
    for (const overlay of shot.annotations) {
      if (annotationIds.has(overlay.id)) add(errors, 'duplicate_annotation', `${shot.id}: ${overlay.id}`);
      annotationIds.add(overlay.id);
      if (['text', 'attribution', 'chapter'].includes(overlay.kind) && !overlay.text?.trim()) add(errors, 'missing_annotation_text', `${shot.id}: ${overlay.id}`);
      if (['arrow', 'scribble', 'highlight'].includes(overlay.kind) && !overlay.target?.trim()) add(errors, 'missing_annotation_target', `${shot.id}: ${overlay.id}`);
      if (overlay.atomId && !atoms.has(overlay.atomId)) add(errors, 'missing_overlay_atom', `${shot.id}: ${overlay.atomId}`);
      if (overlay.kind === 'component' && (!overlay.atomId || atoms.get(overlay.atomId)?.type !== 'custom_component')) add(errors, 'invalid_component_overlay', shot.id);
      if (overlay.startSeconds + overlay.durationSeconds > shot.durationSeconds + 0.001) add(errors, 'overlay_outside_shot', shot.id);
      if (!overlay.placement) add(pending, 'unresolved_placement', `${shot.id}: ${overlay.id}`);
    }
    if (shot.captions.cueIds.some(id => !cues.has(id))) add(errors, 'missing_caption_cue', shot.id);
    if (plan.timingBasis === 'aligned' && shot.captions.mode !== 'none' && !shot.captions.cueIds.length) add(pending, 'missing_caption_cues', shot.id);
    total += shot.durationSeconds;
  }
  for (const [id, words] of coverage) {
    if (words.some(count => count === 0)) add(errors, 'uncovered_script', id);
    if (words.some(count => count > 1)) add(errors, 'overlapping_script', id);
  }
  for (const cue of plan.captionCues) if (cue.endSeconds > total + 0.05) add(errors, 'caption_outside_timeline', cue.id);
  const actual = Object.fromEntries(Object.entries(durationByType).map(([type, seconds]) => [type, total ? 100 * seconds / total : 0]));
  for (const type of ATOM_TYPES) if (Math.abs(actual[type] - (plan.composition.targets[type] || 0)) > plan.composition.tolerancePercentagePoints + 0.001) add(errors, 'composition_mismatch', `${type}: target ${plan.composition.targets[type] || 0}%, actual ${actual[type].toFixed(2)}%`);
  if (plan.edit) {
    const report = checkEdit(plan);
    errors.push(...report.errors);
    pending.push(...report.pending);
  }
  const needed = usedAtoms(plan);
  for (const id of needed) {
    const asset = plan.assets[id];
    if (!asset) { add(pending, 'missing_asset', id); continue; }
    try {
      const metadata = await fileMetadata(await projectPath(root, asset.path, true));
      if (asset.sha256 !== metadata.sha256 || asset.bytes !== metadata.bytes) add(errors, 'asset_hash_mismatch', id);
      if (asset.provenance.sidecarPath) await projectPath(root, asset.provenance.sidecarPath, true);
      if (asset.component) for (const reference of asset.component.registryReferences) await projectPath(root, reference.referencePath, true);
    } catch (error) { add(errors, 'asset_file', `${id}: ${error.message}`); }
    const atom = atoms.get(id);
    if (atom?.type === 'custom_component' && !asset.component) add(errors, 'missing_component_contract', id);
    if (asset.mediaType === 'video' && !asset.durationSeconds) add(pending, 'unmeasured_duration', id);
    if (atom?.type === 'generated_video' && atom.provider === 'local_ltx_2_5' && (!asset.durationSeconds || asset.durationSeconds < 3 || asset.durationSeconds > 8)) add(errors, 'invalid_generated_duration', id);
    if (asset.provenance.rightsStatus === 'review-required') add(warnings, 'rights_review_required', id);
  }
  for (const id of Object.keys(plan.assets)) if (!atoms.has(id)) add(errors, 'orphan_asset', id);
  if (plan.timingBasis !== 'aligned') add(pending, 'estimated_timing', 'Align shots and captions to narration before assembly');
  plan.unresolved.forEach(message => add(pending, 'unresolved', message));
  return {valid: !errors.length, assemblyReady: !errors.length && !pending.length, errors, pending, warnings, durationSeconds: total, composition: actual, assetsReady: [...needed].every(id => Boolean(plan.assets[id])) && !errors.length};
}

function frameRanges(plan) {
  const fps = plan.edit.fps;
  let seconds = 0;
  return plan.shots.map(shot => {
    const startFrame = Math.round(seconds * fps);
    seconds += shot.durationSeconds;
    return {id: shot.id, startFrame, endFrame: Math.round(seconds * fps)};
  });
}

function checkEdit(plan) {
  const errors = [], pending = [];
  const shots = frameRanges(plan);
  const endFrame = shots.at(-1).endFrame;
  const audio = new Map();
  const actions = new Set();
  const error = (code, message) => errors.push({code, message});
  for (const shot of shots) {
    if (shot.endFrame <= shot.startFrame) error('empty_frame_range', shot.id);
  }
  for (const cue of plan.edit.audio) {
    if (audio.has(cue.id)) error('duplicate_audio_cue', cue.id);
    audio.set(cue.id, cue);
    const atom = plan.atoms.find(atom => atom.id === cue.atomId);
    if (atom?.type !== 'narration' && !(atom?.type === 'provided_media' && atom.mediaType === 'audio')) error('invalid_audio_atom', cue.id);
    if (atom?.type === 'narration' && cue.role !== 'narration') error('invalid_narration_role', cue.id);
    if (cue.endFrame <= cue.startFrame || cue.endFrame > endFrame) error('audio_outside_timeline', cue.id);
    const asset = plan.assets[cue.atomId];
    if (asset && asset.mediaType !== 'audio') error('invalid_audio_asset', cue.id);
    if (asset && !asset.durationSeconds) pending.push({code: 'unmeasured_audio', message: cue.id});
    if (plan.timingBasis === 'aligned' && asset?.durationSeconds && cue.sourceInSeconds + (cue.endFrame - cue.startFrame) / plan.edit.fps > asset.durationSeconds + 1 / plan.edit.fps) error('audio_trim_outside_asset', cue.id);
  }
  for (const action of plan.edit.actions) {
    if (actions.has(action.id)) error('duplicate_action_cue', action.id);
    actions.add(action.id);
    const shot = shots.find(shot => shot.id === action.shotId);
    if (!shot || action.frame < shot.startFrame || action.frame >= shot.endFrame) error('action_outside_shot', action.id);
    if (action.audioCueId) {
      const cue = audio.get(action.audioCueId);
      if (cue?.role !== 'sfx' || cue.startFrame !== action.frame) error('unsynced_action_audio', action.id);
    }
  }
  return {errors, pending};
}

export async function prepareAssembly({planPath}) {
  const {plan, root} = await loadPlan(planPath);
  if (!plan.edit) throw new Error('Add an edit configuration before preparing assembly');
  const validation = await validateDocument(plan, root);
  if (!validation.valid) throw new Error('Fix the plan errors before preparing assembly: ' + JSON.stringify(validation.errors));
  const {checks} = await planningInputs(root, {checksFile: plan.checksFile});
  if (checks.requireReviewedTranscript && plan.timingBasis !== 'aligned') throw new Error('Align the plan to the reviewed transcript before assembly');
  const {fps, width, height, audio, actions} = plan.edit;
  const ranges = frameRanges(plan);
  const used = usedAtoms(plan);
  return {
    schemaVersion: '1.0', planRevision: plan.revision, timingBasis: plan.timingBasis,
    assemblyReady: validation.assemblyReady, pending: validation.pending, warnings: validation.warnings,
    fps, width, height, durationInFrames: ranges.at(-1).endFrame,
    shots: plan.shots.map((shot, index) => ({
      ...shot, ...ranges[index],
      motion: {...shot.motion, keyframes: shot.motion.keyframes.map(keyframe => ({...keyframe, frame: ranges[index].startFrame + Math.round(keyframe.offsetSeconds * fps)}))},
    })),
    captions: plan.captionCues.map(cue => ({...cue, startFrame: Math.round(cue.startSeconds * fps), endFrame: Math.round(cue.endSeconds * fps)})),
    audio, actions, transcript: plan.transcript,
    assets: Object.fromEntries(Object.entries(plan.assets).filter(([id]) => used.has(id))),
  };
}

export async function validatePlan(planPath) {
  const {plan, root} = await loadPlan(planPath);
  return validateDocument(plan, root);
}

export async function inspectPlan(planPath) {
  const {plan, root} = await loadPlan(planPath);
  let start = 0;
  return {schemaVersion: plan.schemaVersion, revision: plan.revision, status: plan.status, validation: await validateDocument(plan, root), production: plan.production, shots: plan.shots.map(shot => { const result = {id: shot.id, startSeconds: start, durationSeconds: shot.durationSeconds, script: shot.scriptSpan.text, atomId: shot.primaryAtomId, asset: plan.assets[shot.primaryAtomId] || null}; start += shot.durationSeconds; return result; })};
}

function taskFor(atom, plan, root) {
  return {atomId: atom.id, type: atom.type, intent: atom, projectDir: root, guidance: plan.project, dependencyAssets: Object.fromEntries(dependencies(atom).map(id => [id, plan.assets[id]])), shots: plan.shots.filter(shot => shot.primaryAtomId === atom.id || shot.annotations.some(item => item.atomId === atom.id)), instructions: {
    stock_image: 'Search permitted stock sources, visually choose an exact result, then call produce with selections. Preserve provenance.',
    stock_video: 'Search stock first for ordinary B-roll or reactions. Choose by action, readability at the target crop and rights. Provide selections to produce, then record measured duration and exact trims.',
    generated_image: 'Use the exposed ChatGPT image-generation tool, preserving references and channel style. Call attach_asset with the resulting local file.',
    narration: 'Confirm the voice and commercial rights. Use produce with explicit narrationUse to synthesize through ElevenLabs, then align timing to the measured take.',
    generated_video: atom.provider === 'google_flow'
      ? 'Open the authorized Flow session, check compatible frame mode, duration, audio and credits. Use the attached image inputs and prompt. Inspect and attach the actual measured output; record source trim and audio mode.'
      : 'Use local LTX 2.5 with the resolved reference images. Produce a 3–8 second clip and attach measured duration. Never claim generation without an actual file.',
    custom_component: 'Search and inspect permitted component registries for this visual purpose. Fetch useful references; build a frame-driven React component in the project. Attach its entry point, props, dependencies, and source references. A registry JSON is not a built component.',
    source_evidence: 'Find authoritative evidence for this claim, capture using available tools, preserve source URL and attribution, then attach the actual file.',
    provided_media: 'Attach the declared existing project file with its provenance.',
    image_sequence: 'Create an ordered sequence manifest referencing the resolved image assets.',
  }[atom.type]};
}

export async function nextProductionTasks(planPath, shotIds) {
  const {plan, root} = await loadPlan(planPath);
  const selected = selectedAtoms(plan, shotIds);
  const inputs = await planningInputs(root, {checksFile: plan.checksFile, transcriptPath: plan.transcript?.path});
  const planningErrors = checkPlanningInputs(plan, inputs, plan.edit ? frameRanges(plan) : []);
  const tasks = [], blocked = [];
  for (const atom of plan.atoms.filter(atom => selected.has(atom.id) && !plan.assets[atom.id])) {
    const missing = dependencies(atom).filter(id => !plan.assets[id]);
    if (planningErrors.length || (inputs.checks.requireReviewedTranscript && plan.timingBasis !== 'aligned' && atom.type !== 'narration')) {
      blocked.push({atomId: atom.id, reason: planningErrors.length ? planningErrors : 'Align the visual plan to the reviewed narration first.'});
    }
    else if (missing.length) blocked.push({atomId: atom.id, dependsOn: missing});
    else tasks.push({...taskFor(atom, plan, root), ...(plan.production[atom.id]?.task || {})});
  }
  return {revision: plan.revision, tasks, blocked};
}

export async function revisePlan({planPath, draft, expectedRevision, invalidateAtomIds = [], transcriptPath, checksFile}) {
  return locked(planPath, async () => {
    const {plan, root, file} = await loadPlan(planPath), previous = structuredClone(plan);
    if (expectedRevision !== plan.revision) throw new Error('Plan revision changed; reload before revising');
    const next = draftSchema.parse(draft);
    for (const id of invalidateAtomIds) if (!plan.atoms.some(atom => atom.id === id)) throw new Error(`Unknown invalidated atom: ${id}`);
    const invalidated = new Set(invalidateAtomIds);
    // Changing a reference invalidates every generated asset depending on it.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const atom of plan.atoms) if (!invalidated.has(atom.id) && dependencies(atom).some(id => invalidated.has(id))) { invalidated.add(atom.id); expanded = true; }
    }
    for (const [id] of Object.entries(plan.assets)) {
      const before = plan.atoms.find(atom => atom.id === id), after = next.atoms.find(atom => atom.id === id);
      if (JSON.stringify(before) !== JSON.stringify(after) && !invalidated.has(id)) throw new Error(`Explicitly invalidate changed asset ${id} before revising its intent`);
      if (invalidated.has(id)) { delete plan.assets[id]; delete plan.production[id]; }
    }
    if (!next.edit) delete plan.edit;
    const inputs = await planningInputs(root, {checksFile: checksFile ?? plan.checksFile, transcriptPath: transcriptPath ?? plan.transcript?.path});
    plan.project.guidance = inputs.context.guidance;
    plan.transcript = inputs.transcriptRef;
    if (inputs.transcript) plan.script = transcriptScript(inputs.transcript);
    plan.checksFile = checksFile ?? plan.checksFile;
    Object.assign(plan, next);
    const report = await validateDocument(plan, root);
    if (report.errors.length) throw new Error(`Invalid revision: ${JSON.stringify(report.errors)}`);
    updateStatus(plan, report); await savePlan(file, plan, previous);
    return {revision: plan.revision, status: plan.status, invalidatedAtomIds: [...invalidated], validation: report};
  });
}

function selectedAtoms(plan, shotIds) {
  if (!shotIds?.length) return usedAtoms(plan);
  for (const id of shotIds) if (!plan.shots.some(shot => shot.id === id)) throw new Error(`Unknown shot: ${id}`);
  if (!plan.edit) return usedAtoms({...plan, shots: plan.shots.filter(shot => shotIds.includes(shot.id))});
  const frames = frameRanges(plan).filter(shot => shotIds.includes(shot.id));
  const audio = plan.edit.audio.filter(cue => frames.some(shot => cue.startFrame < shot.endFrame && cue.endFrame > shot.startFrame));
  return usedAtoms({...plan, edit: {...plan.edit, audio}, shots: plan.shots.filter(shot => shotIds.includes(shot.id))});
}

async function ltxConfig() {
  const file = resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'), 'scenesupply/production.json');
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!config.ltx) return null;
  const {command, args = [], timeoutSeconds = 1800} = config.ltx;
  if (typeof command !== 'string' || !command.startsWith('/') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) throw new Error('Invalid LTX adapter: use an absolute command, string args, and timeoutSeconds 1–7200');
  return {command, args, timeoutSeconds};
}

async function runLtx(config, task, destinationDir) {
  // Trusted, machine-level adapter only. No shell or project-supplied executable.
  return new Promise((resolveResult, reject) => {
    const child = spawn(config.command, config.args, {shell: false, stdio: ['pipe', 'pipe', 'pipe'], timeout: config.timeoutSeconds * 1000});
    let output = '', size = 0;
    child.stdout.on('data', data => { size += data.length; if (size > 1_000_000) child.kill(); else output += data; });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new Error('LTX adapter could not start')));
    child.on('close', code => { if (code !== 0 || size > 1_000_000) reject(new Error('LTX adapter failed; inspect the local application logs')); else { try { resolveResult(JSON.parse(output)); } catch { reject(new Error('LTX adapter must return one JSON asset result on stdout')); } } });
    child.stdin.end(JSON.stringify({schemaVersion: '1.0', task, destinationDir}));
  });
}

async function materialize(root, atom, input) {
  const parsed = assetSchema.parse(input.asset);
  const target = await projectPath(root, parsed.path);
  if (input.sourceFile && resolve(input.sourceFile) !== target) {
    await mkdir(dirname(target), {recursive: true});
    try { await copyFile(resolve(input.sourceFile), target, 1); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await fileMetadata(resolve(input.sourceFile))).sha256 !== (await fileMetadata(target)).sha256) throw new Error('Destination exists with different content');
    }
  }
  const metadata = await fileMetadata(await projectPath(root, parsed.path, true));
  if (parsed.sha256 && parsed.sha256 !== metadata.sha256) throw new Error('Asset hash does not match file');
  Object.assign(parsed, metadata);
  const expected = {stock_image: 'image', stock_video: 'video', generated_image: 'image', generated_video: 'video', narration: 'audio', custom_component: 'component', image_sequence: 'sequence', provided_media: atom.mediaType};
  if (expected[atom.type] && parsed.mediaType !== expected[atom.type]) throw new Error(`Expected ${expected[atom.type]} asset for ${atom.id}`);
  if (atom.type === 'generated_video' && !parsed.durationSeconds) throw new Error('Generated video must include measured duration');
  if (atom.type === 'generated_video' && atom.provider === 'local_ltx_2_5' && (!parsed.durationSeconds || parsed.durationSeconds < 3 || parsed.durationSeconds > 8 || Math.abs(parsed.durationSeconds - atom.durationSeconds) > 0.1)) throw new Error('Generated video duration must match planned duration within 0.1s and stay within 3–8s');
  if (atom.type === 'custom_component' && (!parsed.component || !/\.[cm]?[jt]sx?$/.test(parsed.path))) throw new Error('A built JS/TS component and frame-driven component contract are required');
  if (atom.type === 'source_evidence' && !parsed.provenance.sourceUrl) throw new Error('Evidence needs an original source URL');
  if (atom.type === 'image_sequence' && JSON.stringify(parsed.sequenceAtomIds) !== JSON.stringify(atom.referenceAtomIds)) throw new Error('Sequence must preserve the planned image order');
  return parsed;
}

function updateStatus(plan, report) {
  plan.status = report.assemblyReady ? 'assembly_ready' : report.assetsReady ? 'assets_ready' : 'in_production';
}

export async function attachAsset({planPath, atomId, asset, sourceFile, shotUpdates = [], expectedRevision}) {
  return locked(planPath, async () => {
    const {plan, root, file} = await loadPlan(planPath), previous = structuredClone(plan);
    if (expectedRevision != null && expectedRevision !== plan.revision) throw new Error('Plan revision changed; reload before attaching');
    const atom = plan.atoms.find(atom => atom.id === atomId);
    if (!atom) throw new Error(`Unknown atom: ${atomId}`);
    const existing = plan.assets[atomId];
    if (existing && expectedRevision == null) throw new Error('Metadata updates require expectedRevision');
    if (existing && asset.path !== existing.path) throw new Error('Explicitly invalidate the atom before replacing its file');
    if (dependencies(atom).some(id => !plan.assets[id])) throw new Error('Attach reference images before dependent assets');
    plan.assets[atomId] = await materialize(root, atom, {asset, sourceFile});
    if (existing && existing.sha256 !== plan.assets[atomId].sha256) throw new Error('Explicitly invalidate the atom before replacing its content');
    for (const update of shotUpdates) {
      const shot = plan.shots.find(shot => shot.id === update.id);
      if (!shot || shot.primaryAtomId !== atomId && !shot.annotations.some(item => item.atomId === atomId)) throw new Error('Shot update must reference the attached atom');
      if (update.playback) shot.playback = update.playback;
      for (const placement of update.placements || []) {
        const overlay = shot.annotations.find(item => item.id === placement.annotationId);
        if (!overlay) throw new Error('Unknown annotation');
        overlay.placement = placement.placement;
      }
    }
    plan.production[atomId] = {status: 'complete'};
    planSchema.parse(plan);
    const report = await validateDocument(plan, root);
    if (report.errors.length) throw new Error(`Attachment invalid: ${JSON.stringify(report.errors)}`);
    updateStatus(plan, report); await savePlan(file, plan, previous);
    return {revision: plan.revision, status: plan.status, asset: plan.assets[atomId], validation: report};
  });
}

export async function produce({planPath, shotIds, selections = {}, narrationUse}) {
  return locked(planPath, async () => {
    const {plan, root, file} = await loadPlan(planPath), previous = structuredClone(plan);
    const validation = await validateDocument(plan, root);
    if (validation.errors.length) throw new Error(`Fix plan errors before production: ${JSON.stringify(validation.errors)}`);
    const selected = selectedAtoms(plan, shotIds), ltx = await ltxConfig();
    const {checks} = await planningInputs(root, {checksFile: plan.checksFile, transcriptPath: plan.transcript?.path});
    const completed = [], tasks = [], blocked = [], failures = [];
    for (const atom of plan.atoms.filter(atom => selected.has(atom.id) && !plan.assets[atom.id])) {
      const missing = dependencies(atom).filter(id => !plan.assets[id]);
      if (missing.length) { blocked.push({atomId: atom.id, dependsOn: missing}); continue; }
      if (checks.requireReviewedTranscript && plan.timingBasis !== 'aligned' && atom.type !== 'narration') {
        blocked.push({atomId: atom.id, reason: 'Align the visual plan to the reviewed narration first.'});
        continue;
      }
      const task = taskFor(atom, plan, root);
      try {
        const directory = await projectPath(root, `assets/scenesupply/${atom.id}`);
        await mkdir(directory, {recursive: true});
        let asset;
        if (['stock_image', 'stock_video'].includes(atom.type)) {
          const selection = selections[atom.id] || atom.selection;
          if (!selection) {
            const search = await searchStock({query: atom.query, type: atom.type === 'stock_image' ? 'image' : 'video', providers: atom.providers, limit: 10});
            task.candidates = search.results; task.sourceErrors = search.errors;
          } else {
            if (!/^[a-zA-Z0-9_-]+$/.test(String(selection.id))) throw new Error('Invalid stock provider ID');
            if (!atom.providers.includes(selection.provider) || selection.type !== (atom.type === 'stock_image' ? 'image' : 'video')) throw new Error('Selected stock does not match permitted providers/type');
            const extension = selection.type === 'image' ? 'jpg' : 'mp4';
            const recoveredFile = resolve(directory, `${selection.provider}-${selection.id}.${extension}`);
            let downloaded;
            try {
              const provenanceFile = `${recoveredFile}.asset.json`;
              const provenance = JSON.parse(await readFile(provenanceFile, 'utf8'));
              const metadata = await fileMetadata(recoveredFile);
              if (provenance.sha256 !== metadata.sha256 || provenance.provider !== selection.provider || String(provenance.providerId) !== String(selection.id)) throw new Error('Existing stock provenance mismatch');
              downloaded = {file: recoveredFile, provenanceFile};
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              downloaded = await downloadStock(selection, directory);
            }
            asset = {path: relativeFile(root, downloaded.file), mediaType: selection.type, durationSeconds: selection.duration || undefined, provenance: {provider: selection.provider, providerId: String(selection.id), sourceUrl: selection.sourcePage || undefined, sidecarPath: relativeFile(root, downloaded.provenanceFile), rightsStatus: 'review-required', notes: 'Selected stock downloaded; inspect footage and resolve trims before assembly.'}};
          }
        } else if (atom.type === 'provided_media') {
          asset = {path: atom.path, mediaType: atom.mediaType, provenance: {provider: 'project', rightsStatus: 'user-provided', notes: atom.usage}};
        } else if (atom.type === 'image_sequence') {
          const path = relativeFile(root, resolve(directory, 'sequence.json'));
          const content = JSON.stringify({images: atom.referenceAtomIds.map(id => ({atomId: id, path: plan.assets[id].path})), playback: atom.playback}, null, 2) + '\n';
          const target = await projectPath(root, path);
          try { await writeFile(target, content, {flag: 'wx'}); }
          catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(target, 'utf8') !== content) throw new Error('Sequence file differs; choose a new asset path for this revision'); }
          asset = {path, mediaType: 'sequence', sequenceAtomIds: atom.referenceAtomIds, provenance: {provider: 'scenesupply', rightsStatus: 'review-required', notes: 'Sequence inherits underlying image provenance.'}};
        } else if (atom.type === 'narration' && narrationUse) {
          asset = await produceNarration(root, atom, directory, narrationUse);
        } else if (atom.type === 'generated_video' && atom.provider === 'local_ltx_2_5' && ltx) {
          const result = await runLtx(ltx, task, directory);
          asset = await materialize(root, atom, result);
        }
        if (asset) {
          plan.assets[atom.id] = await materialize(root, atom, {asset});
          plan.production[atom.id] = {status: 'complete'}; completed.push(atom.id);
        } else {
          plan.production[atom.id] = {status: 'awaiting_agent', task}; tasks.push(task);
        }
      } catch (error) {
        plan.production[atom.id] = {status: 'failed', error: error.message}; failures.push({atomId: atom.id, error: error.message});
      }
      // Checkpoint each result, including failures, so a later interruption does not lose completed work.
      const report = await validateDocument(plan, root); updateStatus(plan, report);
      await savePlan(file, plan, previous); Object.assign(previous, structuredClone(plan));
    }
    return {revision: plan.revision, status: plan.status, completed, tasks, blocked, failures, validation: await validateDocument(plan, root)};
  });
}
