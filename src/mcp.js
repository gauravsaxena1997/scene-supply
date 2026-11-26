#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {searchStock, downloadStock, STOCK_PROVIDERS} from './stock.js';
import {searchComponents, inspectComponent, fetchComponent, COMPONENT_SOURCES} from './components.js';
import {sourceStatus, planVisuals, produce, attachAsset, revisePlan, validatePlan, inspectPlan, nextProductionTasks, prepareAssembly} from './workflow.js';
import {draftSchema, assetSchema, compositionSchema, playbackSchema, getSchemas} from './schemas.js';
import {readProjectContext, readKnowledge} from './project.js';
import {narrationStatus} from './narration.js';

function result(value) {
  return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value};
}

function register(server, name, description, inputSchema, handler, readOnly = true) {
  server.registerTool(name, {
    description,
    inputSchema,
    annotations: {readOnlyHint: readOnly},
  }, async args => {
    try {
      return result(await handler(args));
    } catch (error) {
      return {isError: true, content: [{type: 'text', text: error.message}]};
    }
  });
}

function createServer() {
  const server = new McpServer({name: 'scenesupply', version: '0.3.0'}, {capabilities: {tools: {}}});

  register(server, 'source_status', 'Report configuration and execution routes without claiming live health or exposing keys.', z.object({}), sourceStatus);

  register(server, 'narration_status', 'Check ElevenLabs subscription and usage without generating audio or exposing credentials.', z.object({}), narrationStatus);
  register(server, 'prepare_assembly', 'Emit the project renderer manifest with exact visual, audio, caption and action timing and pending gates. Does not render.', z.object({planPath: z.string().min(1)}), prepareAssembly);

  register(server, 'get_workflow_guidance', 'Read the versioned generic SOP and schemas before planning/production. The agent makes creative decisions; SceneSupply saves and validates them.', z.object({}),
    async () => ({knowledge: await readKnowledge(), schemas: getSchemas()}));
  register(server, 'read_project_context', 'Read channel guidance/configuration and resolved style defaults from the consuming project.', z.object({projectDir: z.string().min(1)}),
    args => readProjectContext(args.projectDir));
  register(server, 'plan', 'Prepare a script/channel planning brief. With draft, validate and save visual-plan.json. Ask if composition is missing unless automatic=true. No assets generated.', z.object({
    projectDir: z.string().min(1), scriptPath: z.string().optional(), script: z.string().optional(),
    transcriptPath: z.string().optional(), checksFile: z.string().optional(), draft: draftSchema.optional(), output: z.string().default('visual-plan.json'), composition: compositionSchema.optional(), automatic: z.boolean().default(false), allowGenericStyle: z.boolean().default(false), resolvedStyles: z.record(z.string(), z.json()).optional(),
  }), planVisuals, false);
  register(server, 'produce', 'Checkpoint production: download explicitly selected stock, attach provided media, build image sequences, run configured LTX adapter, or synthesize narration only with explicit narrationUse. Return agent tasks for ChatGPT images, component coding, evidence capture and stock selection. Resume skips attached assets. Does not render.', z.object({
    planPath: z.string().min(1), narrationUse: z.enum(['commercial', 'noncommercial']).optional(), shotIds: z.array(z.string()).optional(), selections: z.record(z.string(), z.object({provider: z.enum(STOCK_PROVIDERS), type: z.enum(['image', 'video']), id: z.string(), sourcePage: z.string().url().nullable().optional(), creator: z.string().nullable().optional(), duration: z.number().positive().nullable().optional()})).default({}),
  }), produce, false);
  register(server, 'next_production_tasks', 'Return dependency-ready agent tasks and blocked atoms without producing files.', z.object({planPath: z.string().min(1), shotIds: z.array(z.string()).optional()}), args => nextProductionTasks(args.planPath, args.shotIds));
  register(server, 'attach_asset', 'Attach a real generated/captured/component asset, preserving project-relative paths and provenance. Optionally resolve trims/placements for shots using this atom. Requires measured metadata for generated clips.', z.object({
    planPath: z.string().min(1), atomId: z.string().min(1), asset: assetSchema, sourceFile: z.string().optional(), expectedRevision: z.number().int().positive().optional(),
    shotUpdates: z.array(z.object({id: z.string(), playback: playbackSchema.optional(), placements: z.array(z.object({annotationId: z.string(), placement: z.record(z.string(), z.json())})).optional()})).default([]),
  }), attachAsset, false);
  register(server, 'revise_plan', 'Save explicit creative/timing/placement revisions against an expected revision. Invalidate changed attached atoms explicitly; dependent generated assets are also invalidated. Preserve history.', z.object({
    planPath: z.string().min(1), transcriptPath: z.string().optional(), checksFile: z.string().optional(), draft: draftSchema, expectedRevision: z.number().int().positive(), invalidateAtomIds: z.array(z.string()).default([]),
  }), revisePlan, false);
  register(server, 'validate_plan', 'Check schema, transcript coverage/order, composition, dependencies, asset hashes, trims and assembly readiness. Does not render or certify visual quality.', z.object({planPath: z.string().min(1)}), args => validatePlan(args.planPath));
  register(server, 'inspect_plan', 'Summarize shots, timing, assets, production progress and unresolved decisions.', z.object({planPath: z.string().min(1)}), args => inspectPlan(args.planPath));

  register(server, 'search_stock', 'Search stock images or videos with provider errors and attribution. Coverr offers videos only.', z.object({
    query: z.string().min(1),
    type: z.enum(['image', 'video']).default('video'),
    providers: z.array(z.enum(STOCK_PROVIDERS)).default(STOCK_PROVIDERS),
    limit: z.number().int().min(1).max(80).default(10),
  }), args => searchStock(args));

  register(server, 'download_stock', 'Download a chosen result into a project folder with provenance. Review rights before publication.', z.object({
    item: z.object({provider: z.enum(STOCK_PROVIDERS), type: z.enum(['image', 'video']), id: z.union([z.string(), z.number()]), sourcePage: z.string().nullable().optional(), creator: z.string().nullable().optional()}),
    destinationDir: z.string().min(1),
  }), args => downloadStock(args.item, args.destinationDir), false);

  register(server, 'search_components', 'Search five public UI registries. Tailark Quartz must be requested explicitly.', z.object({
    query: z.string().min(1),
    sources: z.array(z.enum(Object.keys(COMPONENT_SOURCES))).default(Object.keys(COMPONENT_SOURCES).filter(name => name !== 'tailark-quartz')),
    limit: z.number().int().min(1).max(100).default(20),
  }), args => searchComponents(args));

  register(server, 'inspect_component', 'Inspect registry component files and dependencies.', z.object({
    source: z.enum(Object.keys(COMPONENT_SOURCES)),
    name: z.string().min(1),
  }), args => inspectComponent(args.source, args.name));

  register(server, 'fetch_component', 'Save a component registry item and source metadata for review. Does not install it.', z.object({
    source: z.enum(Object.keys(COMPONENT_SOURCES)),
    name: z.string().min(1),
    destinationDir: z.string().min(1),
  }), args => fetchComponent(args.source, args.name, args.destinationDir), false);

  return server;
}

serveStdio(createServer);
