// Tells the API which release each ring of registers should install.
//   offer:   node scripts/offer-release.mjs offer --version 1.4.0 --ring pilot --manifest release/latest.json
//   promote: node scripts/offer-release.mjs promote --version 1.4.0
// Needs API_BASE_URL and RELEASE_DEPLOY_TOKEN in the environment.
// The request shapes must match the release schemas in packages/shared/src/schemas.ts.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: 'string' },
    ring: { type: 'string', default: 'pilot' },
    manifest: { type: 'string' },
  },
});

const command = positionals[0];
const { API_BASE_URL, RELEASE_DEPLOY_TOKEN } = process.env;
if (!API_BASE_URL || !RELEASE_DEPLOY_TOKEN) fail('API_BASE_URL and RELEASE_DEPLOY_TOKEN are required');
if (!/^\d+\.\d+\.\d+$/.test(values.version ?? '')) fail('--version X.Y.Z is required');

if (command === 'offer') {
  if (!values.manifest) fail('--manifest is required');
  const manifest = JSON.parse(readFileSync(values.manifest, 'utf8'));
  if (manifest.version !== values.version && manifest.version !== `v${values.version}`) {
    fail(`latest.json is for ${manifest.version}, not ${values.version}`);
  }
  // With updaterJsonPreferNsis, this entry points at the NSIS bundle.
  const windows = manifest.platforms?.['windows-x86_64'];
  if (!windows?.signature || !windows?.url) fail('latest.json has no windows-x86_64 entry');

  // The repository is public, so registers download straight from the
  // release. The API only accepts URLs under this repo's releases.
  const prefix = 'https://github.com/amlcx/mpf-pos/releases/download/';
  const url = await downloadUrl(windows.url);
  if (!url.startsWith(prefix)) fail(`Unexpected download URL: ${url}`);

  await post('/releases', {
    version: values.version,
    ring: values.ring,
    notes: manifest.notes ?? '',
    pubDate: manifest.pub_date,
    url,
    signature: windows.signature,
  });
  console.log(`Offered ${values.version} to the ${values.ring} ring`);
} else if (command === 'promote') {
  await post('/releases/promote', { version: values.version, from: 'pilot', to: 'stable' });
  console.log(`Promoted ${values.version} from pilot to stable`);
} else {
  fail('First argument must be "offer" or "promote"');
}

/**
 * tauri-action writes the API address of the asset
 * (https://api.github.com/repos/amlcx/mpf-pos/releases/assets/<id>), which
 * only serves the file with a special Accept header. Registers get the
 * asset's ordinary download link instead, as GitHub reports it.
 */
async function downloadUrl(url) {
  const asset = /^https:\/\/api\.github\.com\/repos\/amlcx\/mpf-pos\/releases\/assets\/(\d+)$/.exec(url);
  if (!asset) return url;
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(`${api}/repos/amlcx/mpf-pos/releases/assets/${asset[1]}`, { headers });
  if (!res.ok) fail(`Could not look up release asset ${asset[1]}: ${res.status}`);
  const { browser_download_url: link } = await res.json();
  if (typeof link !== 'string') fail(`Release asset ${asset[1]} has no download URL`);
  return link;
}

async function post(path, body) {
  const res = await fetch(new URL(path, API_BASE_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${RELEASE_DEPLOY_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`${path} answered ${res.status}: ${await res.text()}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
