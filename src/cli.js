#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {credentialStatus, saveCredential} from './config.js';
import {searchStock, downloadStock, STOCK_PROVIDERS} from './stock.js';
import {searchComponents, inspectComponent, fetchComponent, COMPONENT_SOURCES} from './components.js';
import {sourceStatus, planVisuals, produce, attachAsset, revisePlan, validatePlan, inspectPlan, nextProductionTasks} from './workflow.js';
import {getSchemas} from './schemas.js';
import {readProjectContext, readKnowledge} from './project.js';

const usage = `SceneSupply 0.2.0

  scenesupply doctor
  scenesupply source-status
  scenesupply guidance
  scenesupply schemas [--out schemas.json]
  scenesupply context --project <directory>
  scenesupply plan --project <directory> --script <project-relative-script> [--draft draft.json] [--composition composition.json | --automatic] [--styles styles.json] [--allow-generic-style] [--out visual-plan.json]
  scenesupply produce --plan <visual-plan.json> [--shots id,id] [--selections selections.json]
  scenesupply next-production-tasks --plan <visual-plan.json> [--shots id,id]
  scenesupply attach-asset --plan <visual-plan.json> --atom <id> --asset asset.json [--source-file <path>] [--shot-updates updates.json] [--revision N]
  scenesupply revise-plan --plan <visual-plan.json> --draft draft.json --revision N [--invalidate id,id]
  scenesupply validate-plan --plan <visual-plan.json>
  scenesupply inspect-plan --plan <visual-plan.json>
  scenesupply auth set <pexels|pixabay|coverr|tailark-quartz> # reads token from terminal or stdin
  scenesupply stock search <image|video> <query> [--provider all|pexels|pixabay|coverr] [--limit N] [--out results.json]
  scenesupply stock download <results.json> <1-based-index> --out <directory>
  scenesupply components sources
  scenesupply components search <query> [--source all|tailark|tailark-quartz|eldora|cult|kokonut|magicui] [--limit N] [--out results.json]
  scenesupply components inspect <source> <name>
  scenesupply components fetch <source> <name> --out <directory>

All output is JSON. A nonzero exit means the request could not complete.`;

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
}

function listOption(value, all) {
  if (value === 'all') return all;
  if (!all.includes(value)) throw new Error(`Choose one of: all, ${all.join(', ')}`);
  return [value];
}

async function secretFromInput() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stderr.write('API key (input hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = chunk => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\u0003') {
            process.stdin.off('data', onData);
            reject(new Error('Cancelled'));
            return;
          }
          if (char === '\r' || char === '\n') {
            process.stdin.off('data', onData);
            process.stderr.write('\n');
            resolve(value.trim());
            return;
          }
          if (char === '\u007f') value = value.slice(0, -1);
          else value += char;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

async function output(value, file) {
  const content = JSON.stringify(value, null, 2) + '\n';
  if (file) await writeFile(file, content, {flag: 'wx'});
  process.stdout.write(content);
}

async function main(args) {
  const [group, action, ...rest] = args;
  if (!group || group === 'help' || group === '--help') return process.stdout.write(usage + '\n');
  const required = name => { const value = option(args, name, null); if (!value) throw new Error(`${name} is required`); return value; };
  const jsonOption = async name => { const file = option(args, name, null); return file ? JSON.parse(await readFile(file, 'utf8')) : undefined; };
  const shotIds = option(args, '--shots', '').split(',').filter(Boolean);
  if (group === 'source-status') return output(await sourceStatus());
  if (group === 'guidance') return output({knowledge: await readKnowledge()});
  if (group === 'schemas') return output(getSchemas(), option(args, '--out', null));
  if (group === 'context') return output(await readProjectContext(required('--project')));
  if (group === 'plan') return output(await planVisuals({projectDir: required('--project'), scriptPath: required('--script'), draft: await jsonOption('--draft'), composition: await jsonOption('--composition'), automatic: args.includes('--automatic'), allowGenericStyle: args.includes('--allow-generic-style'), resolvedStyles: await jsonOption('--styles'), output: option(args, '--out', 'visual-plan.json')}));
  if (group === 'produce') {
    const result = await produce({planPath: required('--plan'), shotIds, selections: await jsonOption('--selections')});
    await output(result); if (result.failures.length) process.exitCode = 2; return;
  }
  if (group === 'next-production-tasks') return output(await nextProductionTasks(required('--plan'), shotIds));
  if (group === 'attach-asset') return output(await attachAsset({planPath: required('--plan'), atomId: required('--atom'), asset: await jsonOption('--asset'), sourceFile: option(args, '--source-file', undefined), shotUpdates: await jsonOption('--shot-updates'), expectedRevision: option(args, '--revision', null) ? Number(option(args, '--revision')) : undefined}));
  if (group === 'revise-plan') return output(await revisePlan({planPath: required('--plan'), draft: await jsonOption('--draft'), expectedRevision: Number(required('--revision')), invalidateAtomIds: option(args, '--invalidate', '').split(',').filter(Boolean)}));
  if (group === 'validate-plan') {
    const result = await validatePlan(required('--plan')); await output(result); if (!result.valid) process.exitCode = 2; return;
  }
  if (group === 'inspect-plan') return output(await inspectPlan(required('--plan')));
  if (group === 'doctor') return output({credentials: await credentialStatus(), componentSources: Object.fromEntries(
    Object.entries(COMPONENT_SOURCES).map(([name, source]) => [name, {homepage: source.homepage, access: source.access}])
  )});
  if (group === 'auth' && action === 'set') {
    const provider = rest[0];
    const value = await secretFromInput();
    await saveCredential(provider, value);
    return output({provider, status: 'saved to user-level SceneSupply configuration'});
  }
  if (group === 'stock' && action === 'search') {
    const [type, query] = rest;
    const providers = listOption(option(rest, '--provider', 'all'), STOCK_PROVIDERS);
    const result = await searchStock({type, query, providers, limit: Number(option(rest, '--limit', '10'))});
    await output(result, option(rest, '--out', null));
    if (Object.keys(result.errors).length && !result.results.length) process.exitCode = 2;
    return;
  }
  if (group === 'stock' && action === 'download') {
    const [file, indexText] = rest;
    const destination = option(rest, '--out', null);
    if (!file || !Number.isInteger(Number(indexText)) || Number(indexText) < 1) throw new Error('Provide a results file and 1-based index');
    const results = JSON.parse(await readFile(file, 'utf8'));
    const item = results.results?.[Number(indexText) - 1];
    if (!item) throw new Error('Result index is out of range');
    return output(await downloadStock(item, destination));
  }
  if (group === 'components' && action === 'sources') return output(COMPONENT_SOURCES);
  if (group === 'components' && action === 'search') {
    const selected = option(rest, '--source', 'all');
    const sources = selected === 'all'
      ? Object.keys(COMPONENT_SOURCES).filter(name => name !== 'tailark-quartz')
      : listOption(selected, Object.keys(COMPONENT_SOURCES));
    const result = await searchComponents({query: rest[0], sources, limit: Number(option(rest, '--limit', '20'))});
    await output(result, option(rest, '--out', null));
    if (Object.keys(result.errors).length && !result.results.length) process.exitCode = 2;
    return;
  }
  if (group === 'components' && action === 'inspect') return output(await inspectComponent(rest[0], rest[1]));
  if (group === 'components' && action === 'fetch') return output(await fetchComponent(rest[0], rest[1], option(rest, '--out', null)));
  throw new Error(`Unknown command.\n${usage}`);
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`SceneSupply: ${error.message}\n`);
  process.exitCode = 1;
});
