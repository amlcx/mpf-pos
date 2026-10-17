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

  await post('/releases', {
    version: values.version,
    ring: values.ring,
    notes: manifest.notes ?? '',
    pubDate: manifest.pub_date,
    // The API downloads this asset from the GitHub release on the
    // registers' behalf; registers never see a GitHub URL or token.
    assetName: decodeURIComponent(new URL(windows.url).pathname.split('/').pop()),
    signature: windows.signature,
  });
  console.log(`Offered ${values.version} to the ${values.ring} ring`);
} else if (command === 'promote') {
  await post('/releases/promote', { version: values.version, from: 'pilot', to: 'stable' });
  console.log(`Promoted ${values.version} from pilot to stable`);
} else {
  fail('First argument must be "offer" or "promote"');
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
