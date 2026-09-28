#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {credentialStatus} from './config.js';
import {searchStock, downloadStock, STOCK_PROVIDERS} from './stock.js';
import {searchComponents, inspectComponent, fetchComponent, COMPONENT_SOURCES} from './components.js';

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
  const server = new McpServer({name: 'scenesupply', version: '0.1.0'}, {capabilities: {tools: {}}});

  register(server, 'source_status', 'List stock credential status and component sources without exposing keys.', z.object({}),
    async () => ({credentials: await credentialStatus(), componentSources: COMPONENT_SOURCES}));

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
