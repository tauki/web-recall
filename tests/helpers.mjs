import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
export async function loadSource(relative, extraExports = '', mocks = {}, context = {}) {
  const file = path.resolve(relative);
  const source = await readFile(file, 'utf8');
  const built = await build({ stdin: { contents: source + (extraExports ? `\nexport { ${extraExports} };` : ''), loader: 'ts', resolveDir: path.dirname(file) }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', plugins: [{ name: 'fixtures', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: Object.keys(mocks[args.path]).map(name => `export const ${name} = globalThis.__mocks[${JSON.stringify(args.path)}][${JSON.stringify(name)}];`).join('\n') }));
  }}] });
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, __mocks: mocks, console, URL, Date, setTimeout, clearTimeout, performance, AbortSignal, TextDecoder, ...context });
  return module.exports;
}
export const chromeFixture = { runtime: { sendMessage() {}, getURL: value => value, onMessage: { addListener() {} } }, storage: { local: { set(_value, callback) { callback?.(); return Promise.resolve(); } } } };
export const plain = value => JSON.parse(JSON.stringify(value));
export const tick = () => new Promise(resolve => setImmediate(resolve));
