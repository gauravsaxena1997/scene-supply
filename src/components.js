import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {getJson} from './http.js';
import {getCredential} from './config.js';

export const COMPONENT_SOURCES = {
  tailark: {
    catalog: 'https://oss.tailark.com/r/registry.json',
    item: 'https://oss.tailark.com/r/{name}.json',
    homepage: 'https://tailark.com/blocks',
    access: 'free OSS kits; Quartz requires a separate Tailark plan',
  },
  'tailark-quartz': {
    catalog: 'https://tailark.com/r/registry.json',
    item: 'https://tailark.com/r/{name}.json',
    homepage: 'https://tailark.com/blocks/quartz',
    access: 'requires a Tailark plan and API key',
    credential: 'tailark-quartz',
  },
  eldora: {
    catalog: 'https://www.eldoraui.site/r/registry.json',
    item: 'https://www.eldoraui.site/r/{name}.json',
    homepage: 'https://www.eldoraui.site/docs/components',
    access: 'public registry',
  },
  cult: {
    catalog: 'https://raw.githubusercontent.com/nolly-studio/cult-ui/main/apps/www/registry.json',
    item: 'https://raw.githubusercontent.com/nolly-studio/cult-ui/main/apps/www/public/r/{name}.json',
    homepage: 'https://www.cult-ui.com/docs/components',
    access: 'public GitHub registry',
  },
  kokonut: {
    catalog: 'https://kokonutui.com/r/registry.json',
    item: 'https://kokonutui.com/r/{name}.json',
    homepage: 'https://kokonutui.com/docs',
    access: 'public registry',
  },
  magicui: {
    catalog: 'https://magicui.design/r/registry.json',
    item: 'https://magicui.design/r/{name}.json',
    homepage: 'https://magicui.design/docs/components',
    access: 'public registry; Pro templates require a separate plan',
  },
};

function sourceFor(name) {
  const source = COMPONENT_SOURCES[name];
  if (!source) throw new Error(`Unknown component source: ${name}`);
  return source;
}

async function sourceHeaders(source) {
  if (!source.credential) return {};
  const key = await getCredential(source.credential);
  if (!key) throw new Error(`Source requires a key; run scenesupply auth set ${source.credential}`);
  return {'x-api-key': key};
}

export async function searchComponents({query, sources = Object.keys(COMPONENT_SOURCES).filter(name => name !== 'tailark-quartz'), limit = 20}) {
  if (!query || typeof query !== 'string') throw new Error('A search query is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be between 1 and 100');
  sources.forEach(sourceFor);
  const settled = await Promise.allSettled(sources.map(async name => {
    const source = sourceFor(name);
    const catalog = await getJson(source.catalog, await sourceHeaders(source));
    if (!Array.isArray(catalog.items)) throw new Error('Registry returned an unsupported catalog');
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return catalog.items.filter(item => {
      const text = [item.name, item.title, item.description, ...(item.categories || [])].join(' ').toLowerCase();
      return words.every(word => text.includes(word));
    }).slice(0, limit).map(item => ({
      source: name,
      name: item.name,
      title: item.title || item.name,
      description: item.description || '',
      type: item.type || null,
      homepage: sourceFor(name).homepage,
    }));
  }));
  const results = [];
  const errors = {};
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') results.push(...result.value);
    else errors[sources[index]] = result.reason.message;
  });
  return {query, searchedAt: new Date().toISOString(), results, errors};
}

export async function inspectComponent(sourceName, name) {
  const source = sourceFor(sourceName);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) throw new Error('Invalid component name');
  const item = await getJson(source.item.replace('{name}', name), await sourceHeaders(source));
  if (!item || typeof item !== 'object' || !Array.isArray(item.files)) {
    throw new Error('Registry returned an unsupported component item');
  }
  return {
    source: sourceName,
    name: item.name || name,
    title: item.title || item.name || name,
    description: item.description || '',
    type: item.type || null,
    dependencies: item.dependencies || [],
    registryDependencies: item.registryDependencies || [],
    files: item.files.map(file => ({path: file.path, type: file.type})),
    homepage: source.homepage,
    access: source.access,
  };
}

export async function fetchComponent(sourceName, name, destinationDir) {
  if (!destinationDir) throw new Error('An output directory is required');
  const source = sourceFor(sourceName);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) throw new Error('Invalid component name');
  const item = await getJson(source.item.replace('{name}', name), await sourceHeaders(source));
  if (!item || !Array.isArray(item.files)) throw new Error('Registry returned an unsupported component item');
  const directory = resolve(destinationDir);
  await mkdir(directory, {recursive: true});
  const file = join(directory, `${sourceName}-${name}.registry.json`);
  const metadataFile = join(directory, `${sourceName}-${name}.source.json`);
  await writeFile(file, JSON.stringify(item, null, 2) + '\n', {flag: 'wx'});
  await writeFile(metadataFile, JSON.stringify({
    schemaVersion: 1,
    source: sourceName,
    component: name,
    sourceUrl: source.item.replace('{name}', name),
    homepage: source.homepage,
    retrievedAt: new Date().toISOString(),
    reuseStatus: 'review-source-license-and-adapt-before-use',
  }, null, 2) + '\n', {flag: 'wx'});
  return {file, metadataFile};
}
