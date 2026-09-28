import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {link, mkdir, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {getCredential} from './config.js';
import {getJson, safeHttpsUrl} from './http.js';

export const STOCK_PROVIDERS = ['pexels', 'pixabay', 'coverr'];
const LICENSES = {
  pexels: 'https://www.pexels.com/license/',
  pixabay: 'https://pixabay.com/service/license-summary/',
  coverr: 'https://coverr.co/license',
};

function requireKey(provider, key) {
  if (!key) throw new Error(`${provider} is not configured; run scenesupply auth set ${provider}`);
  return key;
}

function normalized(provider, type, record) {
  return {
    provider,
    type,
    id: String(record.id),
    title: record.title || record.alt || record.tags || '',
    creator: record.creator || record.photographer || record.user || null,
    sourcePage: record.sourcePage || record.url || record.pageURL || null,
    preview: record.preview || record.thumbnail || null,
    width: record.width || record.imageWidth || record.max_width || null,
    height: record.height || record.imageHeight || record.max_height || null,
    duration: record.duration == null ? null : Number(record.duration),
    licensePage: LICENSES[provider],
  };
}

function publicCoverrPage(record) {
  const candidate = record.canonical_url || record.url;
  if (typeof candidate !== 'string') return null;
  try {
    const url = safeHttpsUrl(candidate);
    if (!['coverr.co', 'www.coverr.co'].includes(url.hostname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

async function pexelsSearch(query, type, limit, key) {
  const endpoint = type === 'image' ? 'https://api.pexels.com/v1/search' : 'https://api.pexels.com/v1/videos/search';
  const url = new URL(endpoint);
  url.search = new URLSearchParams({query, per_page: String(limit)}).toString();
  const data = await getJson(url, {Authorization: key});
  const items = type === 'image' ? data.photos : data.videos;
  if (!Array.isArray(items)) throw new Error('Pexels returned an unsupported search response');
  return items.map(item => normalized('pexels', type, {
    ...item,
    creator: type === 'image' ? item.photographer : item.user?.name,
    preview: type === 'image' ? item.src?.medium : item.image,
  }));
}

async function pixabaySearch(query, type, limit, key) {
  const url = new URL(type === 'image' ? 'https://pixabay.com/api/' : 'https://pixabay.com/api/videos/');
  url.search = new URLSearchParams({key, q: query, per_page: String(Math.max(limit, 3))}).toString();
  const data = await getJson(url);
  if (!Array.isArray(data.hits)) throw new Error('Pixabay returned an unsupported search response');
  return data.hits.slice(0, limit).map(item => normalized('pixabay', type, {
    ...item,
    preview: type === 'image' ? item.previewURL : item.videos?.medium?.thumbnail,
    width: type === 'image' ? item.imageWidth : item.videos?.medium?.width,
    height: type === 'image' ? item.imageHeight : item.videos?.medium?.height,
  }));
}

async function coverrSearch(query, type, limit, key) {
  if (type !== 'video') return [];
  const url = new URL('https://api.coverr.co/videos');
  url.search = new URLSearchParams({query, page_size: String(limit)}).toString();
  const data = await getJson(url, {Authorization: `Bearer ${key}`});
  if (!Array.isArray(data.hits)) throw new Error('Coverr returned an unsupported search response');
  return data.hits.map(item => normalized('coverr', 'video', {
    ...item,
    creator: item.creator?.name || item.author?.name || null,
    sourcePage: publicCoverrPage(item),
  }));
}

export async function searchStock({query, type = 'video', providers = STOCK_PROVIDERS, limit = 10}) {
  if (!query || typeof query !== 'string') throw new Error('A search query is required');
  if (!['image', 'video'].includes(type)) throw new Error('Type must be image or video');
  if (!Number.isInteger(limit) || limit < 1 || limit > 80) throw new Error('Limit must be between 1 and 80');
  for (const provider of providers) if (!STOCK_PROVIDERS.includes(provider)) throw new Error(`Unknown stock provider: ${provider}`);
  const searches = await Promise.allSettled(providers.map(async provider => {
    if (provider === 'coverr' && type === 'image') return [];
    const key = requireKey(provider, await getCredential(provider));
    return {pexels: pexelsSearch, pixabay: pixabaySearch, coverr: coverrSearch}[provider](query, type, limit, key);
  }));
  const results = [];
  const errors = {};
  searches.forEach((result, index) => {
    if (result.status === 'fulfilled') results.push(...result.value);
    else errors[providers[index]] = result.reason.message;
  });
  return {query, type, searchedAt: new Date().toISOString(), results, errors};
}

async function getDownload(item) {
  const {provider, type, id} = item;
  if (!STOCK_PROVIDERS.includes(provider) || !['image', 'video'].includes(type) || !/^\d+$|^[a-zA-Z0-9_-]+$/.test(String(id))) {
    throw new Error('Invalid stock result');
  }
  const key = requireKey(provider, await getCredential(provider));
  if (provider === 'pexels') {
    const url = type === 'image' ? `https://api.pexels.com/v1/photos/${id}` : `https://api.pexels.com/v1/videos/videos/${id}`;
    const data = await getJson(url, {Authorization: key});
    if (type === 'image') return {url: data.src?.original, extension: 'jpg'};
    const files = (data.video_files || []).filter(f => f.link && f.file_type === 'video/mp4');
    files.sort((a, b) => Math.abs((a.width || 0) - 1920) - Math.abs((b.width || 0) - 1920));
    return {url: files[0]?.link, extension: 'mp4'};
  }
  if (provider === 'pixabay') {
    const url = new URL(type === 'image' ? 'https://pixabay.com/api/' : 'https://pixabay.com/api/videos/');
    url.search = new URLSearchParams({key, id: String(id)}).toString();
    const data = await getJson(url);
    const record = data.hits?.[0];
    return type === 'image'
      ? {url: record?.imageURL || record?.largeImageURL, extension: 'jpg'}
      : {url: record?.videos?.medium?.url || record?.videos?.small?.url, extension: 'mp4'};
  }
  if (type !== 'video') throw new Error('Coverr only supports video in this release');
  const data = await getJson(`https://api.coverr.co/videos/${id}`, {Authorization: `Bearer ${key}`});
  return {url: data.urls?.mp4_download, extension: 'mp4'};
}

export async function downloadStock(item, destinationDir) {
  if (!destinationDir) throw new Error('An output directory is required');
  const {url: downloadUrl, extension} = await getDownload(item);
  if (!downloadUrl) throw new Error('The provider did not return a downloadable rendition');
  safeHttpsUrl(downloadUrl);
  const response = await fetch(downloadUrl, {signal: AbortSignal.timeout(120000)});
  if (!response.ok || !response.body) throw new Error(`Media download returned HTTP ${response.status}`);
  const directory = resolve(destinationDir);
  await mkdir(directory, {recursive: true});
  const basename = `${item.provider}-${item.id}.${extension}`;
  const target = join(directory, basename);
  const temporary = `${target}.${process.pid}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > 2_000_000_000) return callback(new Error('Media exceeds 2 GB download limit'));
    hash.update(chunk);
    callback(null, chunk);
  }});
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, {flags: 'wx'}));
    await link(temporary, target);
    await rm(temporary);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
  const provenance = {
    schemaVersion: 1,
    provider: item.provider,
    type: item.type,
    providerId: String(item.id),
    sourcePage: item.sourcePage,
    creator: item.creator,
    licensePage: LICENSES[item.provider],
    downloadedAt: new Date().toISOString(),
    file: basename,
    sha256: hash.digest('hex'),
    bytes,
    rightsStatus: 'review-required',
  };
  await writeFile(`${target}.asset.json`, JSON.stringify(provenance, null, 2) + '\n', {flag: 'wx'});
  return {file: target, provenanceFile: `${target}.asset.json`, provenance};
}
