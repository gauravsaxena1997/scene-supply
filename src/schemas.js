import {z} from 'zod';

export const ATOM_TYPES = ['stock_image', 'stock_video', 'generated_image', 'generated_video', 'custom_component', 'source_evidence', 'provided_media', 'image_sequence', 'narration'];
export const PUBLIC_COMPONENT_SOURCES = ['tailark', 'eldora', 'cult', 'kokonut', 'magicui'];
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
export const relativePath = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => ['..', '.', ''].includes(part)), 'Use a project-relative path without traversal');
const jsonObject = z.record(z.string(), z.json());
const sources = z.array(z.enum(['pexels', 'pixabay', 'coverr'])).min(1);

export const compositionSchema = z.object({
  mode: z.enum(['manual', 'channel_default', 'automatic']),
  measurement: z.literal('primary_visual_duration').default('primary_visual_duration'),
  targets: z.partialRecord(z.enum(ATOM_TYPES), z.number().min(0).max(100)),
  tolerancePercentagePoints: z.number().min(0).max(100).default(5),
}).strict().refine(value => Math.abs(Object.values(value.targets).reduce((a, b) => a + b, 0) - 100) < 0.001, 'Composition targets must sum to 100');

export const projectConfigSchema = z.object({
  guidanceFiles: z.array(relativePath).default([]),
  allowedAtoms: z.array(z.enum(ATOM_TYPES)).min(1).default(ATOM_TYPES),
  composition: compositionSchema.optional(),
  styles: jsonObject.default({}),
  narrator: jsonObject.optional(),
  personalizationFile: relativePath.optional(),
}).strict();

export const motionSchema = z.object({
  type: z.enum(['none', 'pan', 'zoom_in', 'zoom_out', 'focus', 'sequence', 'custom']),
  description: z.string().min(1),
  target: z.string().optional(),
  keyframes: z.array(z.object({offsetSeconds: z.number().nonnegative(), values: jsonObject}).strict()).default([]),
}).strict();

const stockSelection = z.object({provider: z.enum(['pexels', 'pixabay', 'coverr']), type: z.enum(['image', 'video']), id: z.string().min(1), sourcePage: z.string().url().nullable().optional(), creator: z.string().nullable().optional(), duration: z.number().positive().nullable().optional()}).strict();
const common = {id, description: z.string().min(1), brandRuleRefs: z.array(z.string()).default([])};
export const atomSchema = z.discriminatedUnion('type', [
  z.object({...common, type: z.literal('stock_image'), query: z.string().min(1), providers: sources, selectionCriteria: z.string().min(1), selection: stockSelection.optional()}).strict(),
  z.object({...common, type: z.literal('stock_video'), query: z.string().min(1), providers: sources, selectionCriteria: z.string().min(1), selection: stockSelection.optional()}).strict(),
  z.object({...common, type: z.literal('generated_image'), provider: z.literal('chatgpt_imagegen'), prompt: z.string().min(1), referenceAtomIds: z.array(id).default([]), continuity: z.string().min(1)}).strict(),
  z.object({...common, type: z.literal('generated_video'), provider: z.enum(['local_ltx_2_5', 'google_flow']), referenceAtomIds: z.array(id).min(1), prompt: z.string().min(1), durationSeconds: z.number().positive(), camera: z.string().min(1), flow: z.object({purpose: z.enum(['b_roll', 'silent_reaction', 'spoken_dialogue']), dialogue: z.string().min(1).optional()}).strict().optional()}).strict(),
  z.object({...common, type: z.literal('narration'), provider: z.literal('elevenlabs'), text: z.string().min(1).max(5000), voiceId: id, modelId: id.default('eleven_multilingual_v2')}).strict(),
  z.object({...common, type: z.literal('custom_component'), purpose: z.string().min(1), content: jsonObject, layout: z.string().min(1), animation: z.string().min(1), registrySources: z.array(z.enum(PUBLIC_COMPONENT_SOURCES)).min(1).default(PUBLIC_COMPONENT_SOURCES)}).strict(),
  z.object({...common, type: z.literal('source_evidence'), claim: z.string().min(1), query: z.string().min(1), sourceUrl: z.string().url().optional(), capture: z.enum(['screenshot', 'recording', 'image', 'excerpt'])}).strict(),
  z.object({...common, type: z.literal('provided_media'), path: relativePath, mediaType: z.enum(['image', 'video', 'audio']), usage: z.string().min(1)}).strict(),
  z.object({...common, type: z.literal('image_sequence'), referenceAtomIds: z.array(id).min(2), continuity: z.string().min(1), playback: z.string().min(1)}).strict(),
]);

export const assetSchema = z.object({
  path: relativePath,
  mediaType: z.enum(['image', 'video', 'audio', 'component', 'sequence', 'text']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bytes: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  provenance: z.object({provider: z.string().min(1), sourceUrl: z.string().url().optional(), providerId: z.string().optional(), sidecarPath: relativePath.optional(), rightsStatus: z.enum(['review-required', 'reviewed', 'user-provided']), notes: z.string().min(1)}).strict(),
  component: z.object({exportName: id, props: jsonObject, dependencies: z.array(z.string()), registryReferences: z.array(z.object({source: z.enum(PUBLIC_COMPONENT_SOURCES), name: z.string().min(1), referencePath: relativePath}).strict()), frameDriven: z.literal(true)}).strict().optional(),
  sequenceAtomIds: z.array(id).min(2).optional(),
}).strict();

export const playbackSchema = z.object({sourceInSeconds: z.number().nonnegative(), sourceOutSeconds: z.number().positive(), speed: z.number().positive().default(1), audio: z.enum(['muted', 'original']).default('muted')}).strict();
export const shotSchema = z.object({
  id,
  scriptSpan: z.object({segmentId: id, startWord: z.number().int().nonnegative(), endWordExclusive: z.number().int().positive(), text: z.string().min(1)}).strict(),
  durationSeconds: z.number().positive(),
  purpose: z.string().min(1), primaryAtomId: id,
  motion: motionSchema,
  framing: z.string().min(1),
  annotations: z.array(z.object({id, kind: z.enum(['text', 'arrow', 'scribble', 'highlight', 'attribution', 'chapter', 'component']), text: z.string().optional(), atomId: id.optional(), target: z.string().optional(), startSeconds: z.number().nonnegative(), durationSeconds: z.number().positive(), treatment: z.string().min(1), placement: jsonObject.optional()}).strict()).default([]),
  captions: z.object({mode: z.enum(['bottom', 'primary', 'none']), text: z.string(), cueIds: z.array(id).default([])}).strict(),
  transition: z.string().min(1),
  playback: playbackSchema.optional(),
}).strict();

export const editSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive().max(120),
  audio: z.array(z.object({
    id, atomId: id, role: z.enum(['narration', 'music', 'sfx', 'ambience']),
    startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(),
    sourceInSeconds: z.number().nonnegative().default(0),
    gain: z.number().min(0).max(2).default(1),
  }).strict()).default([]),
  actions: z.array(z.object({
    id, shotId: id, frame: z.number().int().nonnegative(), kind: z.enum(['tap', 'type', 'reveal', 'confirm', 'hold', 'custom']),
    target: z.string().min(1), audioCueId: id.optional(),
  }).strict()).default([]),
}).strict();

export const draftSchema = z.object({
  composition: compositionSchema,
  atoms: z.array(atomSchema).min(1), shots: z.array(shotSchema).min(1),
  timingBasis: z.enum(['estimated', 'aligned']).default('estimated'),
  captionCues: z.array(z.object({id, startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(), text: z.string().min(1)}).strict()).default([]),
  unresolved: z.array(z.string()).default([]),
  edit: editSchema.optional(),
}).strict();

export const planSchema = draftSchema.safeExtend({
  schemaVersion: z.literal('1.0'), revision: z.number().int().positive(),
  status: z.enum(['planned', 'in_production', 'assets_ready', 'assembly_ready']),
  createdAt: z.string(), updatedAt: z.string(),
  project: z.object({root: z.literal('.'), allowedAtoms: z.array(z.enum(ATOM_TYPES)), guidance: z.array(z.object({path: relativePath, sha256: z.string(), content: z.string()}).strict()), styles: jsonObject, narrator: jsonObject.optional()}).strict(),
  script: z.object({sha256: z.string(), segments: z.array(z.object({id, text: z.string(), words: z.array(z.string())}).strict())}).strict(),
  assets: z.record(id, assetSchema).default({}),
  production: z.record(id, z.object({status: z.enum(['pending', 'awaiting_agent', 'failed', 'complete']), task: jsonObject.optional(), error: z.string().optional()}).strict()).default({}),
});

export function getSchemas() {
  return Object.fromEntries(Object.entries({project: projectConfigSchema, draft: draftSchema, plan: planSchema, asset: assetSchema, edit: editSchema}).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
}
