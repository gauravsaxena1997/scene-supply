import {mkdir, readFile, writeFile, chmod, rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const CREDENTIAL_NAMES = {
  pexels: 'PEXELS_API_KEY',
  pixabay: 'PIXABAY_API_KEY',
  coverr: 'COVERR_API_KEY',
  'tailark-quartz': 'TAILARK_API_KEY',
};

const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'scenesupply');
const credentialFile = join(configDir, 'credentials.json');

async function readCredentials() {
  try {
    const data = JSON.parse(await readFile(credentialFile, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function getCredential(provider) {
  const name = CREDENTIAL_NAMES[provider];
  if (!name) throw new Error(`Unknown credential provider: ${provider}`);
  if (process.env[name]) return process.env[name];
  const credentials = await readCredentials();
  return credentials[provider] || null;
}

export async function credentialStatus() {
  const credentials = await readCredentials();
  return Object.fromEntries(Object.entries(CREDENTIAL_NAMES).map(([provider, envName]) => [
    provider,
    process.env[envName] ? 'environment' : credentials[provider] ? 'local file' : 'missing',
  ]));
}

export async function saveCredential(provider, value) {
  if (!CREDENTIAL_NAMES[provider]) throw new Error(`Unknown credential provider: ${provider}`);
  if (typeof value !== 'string' || !value.trim()) throw new Error('Credential cannot be empty');
  await mkdir(configDir, {recursive: true, mode: 0o700});
  await chmod(configDir, 0o700);
  const credentials = await readCredentials();
  credentials[provider] = value.trim();
  const temporary = join(configDir, `credentials.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(credentials, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
  await chmod(temporary, 0o600);
  await rename(temporary, credentialFile);
  await chmod(credentialFile, 0o600);
}
