import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
export async function loadSource(relative, extraExports = '', mocks = {}, context = {}) {
  const file = path.resolve(relative);
  const source = await readFile(file, 'utf8');
  const lexicalFixture = `import { createLexicalSearch } from ${JSON.stringify(path.resolve('src/shared/db/lexicalSearch.ts'))};
    function adaptStorage(storage) {
      if (!storage.scanSearchPages || storage.searchTextPages) return storage;
      return { ...storage, async searchTextPages(query, limit, filters, options = {}) {
        const search = createLexicalSearch(query, limit, filters, options.scopeUrls);
        await storage.scanSearchPages(search.visit, options);
        options.signal?.throwIfAborted();
        return search.finish();
      } };
    }`;
  const built = await build({ stdin: { contents: source + (extraExports ? `\nexport { ${extraExports} };` : ''), loader: 'ts', resolveDir: path.dirname(file) }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', plugins: [{ name: 'fixtures', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (Object.hasOwn(mocks, args.path)) return { path: args.path, namespace: 'fixture' };
      if (args.path.startsWith('.') && path.resolve(args.resolveDir, args.path) === path.resolve('src/background/storage/index')) {
        return { path: 'isolated-idb-backend', namespace: 'legacy-storage-fixture' };
      }
    });
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
      const adapt = args.path === '../storage/manager' && mocks[args.path].storageManager?.scanSearchPages;
      const exports = Object.keys(mocks[args.path]).map(name => {
        const value = `globalThis.__mocks[${JSON.stringify(args.path)}][${JSON.stringify(name)}]`;
        return `export const ${name} = ${adapt && name === 'storageManager' ? `adaptStorage(${value})` : value};`;
      }).join('\n');
      return { contents: adapt ? lexicalFixture + '\n' + exports : exports, resolveDir: path.dirname(file) };
    });
    builder.onLoad({ filter: /.*/, namespace: 'legacy-storage-fixture' }, () => ({
      contents: `${lexicalFixture}
        import * as database from ${JSON.stringify(path.resolve('src/shared/db/index.ts'))};
        const storage = { ...adaptStorage(database), async getBackupBatch(after) {
          return { libraryId: '00000000-0000-0000-0000-000000000001', revision: 0, page: await database.getNextPageRecord(after) };
        }, async listProcessingSummaries() {
          const entries = await database.listProcessing();
          return entries.map(({ url, title, status, attempts, updatedAt, error, textSaved }) => ({ url, title, status, attempts, updatedAt, error, textSaved }))
            .sort((first, second) => second.updatedAt - first.updatedAt);
        } };
        export async function whenStorageReady() { return storage; }
        export function initStorage() {}
        export function invalidateStorageReadiness() {}`,
      resolveDir: path.dirname(file)
    }));
  }}] });
  const module = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, __mocks: mocks, console, URL, Date, setTimeout, clearTimeout, performance, AbortSignal, AbortController, crypto, TextDecoder, TextEncoder, Uint8Array, ...context });
  return module.exports;
}
export const chromeFixture = { runtime: { sendMessage() {}, getURL: value => value, onMessage: { addListener() {} } }, storage: { local: { set(_value, callback) { callback?.(); return Promise.resolve(); } } } };
export const plain = value => JSON.parse(JSON.stringify(value));
export const automaticAiEnabled = { runAutomaticAi: (run, signal) => run(signal || new AbortController().signal), trackAutomaticAi: () => () => {} };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const scanFixturePages = pages => async (visit, { signal, scopeUrls } = {}) => {
  signal?.throwIfAborted();
  const scope = scopeUrls ? new Set(scopeUrls) : undefined;
  for (const page of typeof pages === 'function' ? pages() : pages) {
    signal?.throwIfAborted();
    if (!scope || scope.has(page.url)) visit(page);
  }
  signal?.throwIfAborted();
};

export async function waitFor(predicate, description) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
