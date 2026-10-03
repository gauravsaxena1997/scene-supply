import {readFile, realpath, stat} from 'node:fs/promises';
import {resolve, relative, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {projectConfigSchema} from './schemas.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export async function fileMetadata(path) {
  const info = await stat(path);
  if (!info.isFile() || !info.size) throw new Error('Asset must be a nonempty regular file');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return {sha256: digest.digest('hex'), bytes: info.size};
}
export async function projectPath(root, path, mustExist = false) {
  const base = await realpath(root);
  const target = resolve(base, path);
  const within = candidate => candidate === base || !relative(base, candidate).startsWith(`..${sep}`) && relative(base, candidate) !== '..';
  if (!within(target)) throw new Error('Path must stay within the consuming project');
  let parent = target;
  while (true) {
    try { if (!within(await realpath(parent))) throw new Error('Symlink leaves the consuming project'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = resolve(parent, '..'); }
  }
  if (mustExist) await stat(target);
  return target;
}

async function optionalFile(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readProjectContext(projectDir) {
  const root = await realpath(projectDir);
  const configText = await optionalFile(await projectPath(root, '.scenesupply/project.json'));
  const config = projectConfigSchema.parse(configText ? JSON.parse(configText) : {});
  const files = new Set(config.guidanceFiles);
  for (const name of ['AGENTS.md', 'brand-guidelines.md', 'brand.md', 'BRAND.md', 'guidelines/brand.md']) {
    if (await optionalFile(await projectPath(root, name))) files.add(name);
  }
  const guidance = [];
  for (const path of files) {
    if (/(^|\/)(\.env[^/]*|credentials[^/]*|secrets?[^/]*)$/i.test(path)) throw new Error('Credential files cannot be brand guidance');
    const content = await readFile(await projectPath(root, path, true), 'utf8');
    if (Buffer.byteLength(content) > 256_000) throw new Error(`Guidance file is too large: ${path}`);
    guidance.push({path, sha256: hash(content), content});
  }
  return {root, config, guidance, warnings: guidance.length ? [] : ['No brand guidance discovered; supply guidanceFiles or explicitly authorize generic styling.']};
}

export function scriptDocument(text) {
  if (!text?.trim()) throw new Error('Script cannot be empty');
  return {sha256: hash(text), segments: text.trim().split(/\n\s*\n/).map((text, index) => ({id: `segment-${String(index + 1).padStart(4, '0')}`, text: text.trim(), words: text.trim().split(/\s+/)}))};
}

export async function readKnowledge() {
  return readFile(new URL('../knowledge/planning-and-production.md', import.meta.url), 'utf8');
}
