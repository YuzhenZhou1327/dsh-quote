/**
 * Pre-flight for this bundle: the three places that must agree before the
 * loader can activate the Client half.
 *
 * The module id inside client.js IS the contract: the Host serves the bundle
 * under the package name, and a stale id makes the loader run the bundle twice
 * ("duplicate factory registration") and abort renderer startup — which shows
 * up as a DSH restart crash, not as a plugin error.
 */
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');

const pkg = JSON.parse(read('package.json'));
const client = read('client.js');
const patch = read('cordis.patch.yml');

const declared = /window\.__ModuleLoader__\.load\(\{[^]*?\bid:\s*'([^']+)'/.exec(client)?.[1];
if (declared === undefined) {
  throw new Error('client.js: window.__ModuleLoader__.load({ id }) not found');
}
if (declared !== pkg.name) {
  throw new Error(`client.js module id "${declared}" must equal package.json name "${pkg.name}"`);
}
if (!patch.includes(pkg.name)) {
  throw new Error(`cordis.patch.yml must insert the package name "${pkg.name}"`);
}
if (!pkg.dsh?.bundle?.patch || !pkg.dsh?.client?.platform) {
  throw new Error('package.json: dsh.bundle.patch and dsh.client.platform are required');
}

console.log(`ok: ${pkg.name}@${pkg.version}`);
