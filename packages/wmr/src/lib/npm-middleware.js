import * as rollup from 'rollup';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
// import unpkgPlugin from '../plugins/unpkg-plugin.js';
import npmPlugin, { normalizeSpecifier } from '../plugins/npm-plugin/index.js';
import { resolvePackageVersion, loadPackageFile } from '../plugins/npm-plugin/registry.js';
import { getCachedBundle, setCachedBundle, sendCachedBundle, enqueueCompress } from './npm-middleware-cache.js';
import processGlobalPlugin from '../plugins/process-global-plugin.js';
import aliasPlugin from '../plugins/aliases-plugin.js';
import { getMimeType } from './mimetypes.js';
import nodeBuiltinsPlugin from '../plugins/node-builtins-plugin.js';
import * as kl from 'kolorist';
import { hasDebugFlag, onWarn } from './output-utils.js';
import path from 'path';
import { promises as fs } from 'fs';
import { defaultLoaders } from './default-loaders.js';
import { IMPLICIT_URL, urlPlugin } from '../plugins/url-plugin.js';
import { hasCustomPrefix } from './fs-utils.js';
import { transformImports } from './transform-imports.js';
import wmrStylesPlugin from '../plugins/wmr/styles/styles-plugin.js';

/**
 * Serve a "proxy module" that uses the WMR runtime to load CSS.
 * @param {ReturnType<typeof normalizeSpecifier>} meta
 * @param {import('http').ServerResponse} res
 * @param {boolean} [isModule]
 */
async function handleAsset(meta, res, isModule) {
	let code = '';
	let type = null;

	if (isModule) {
		type = 'application/javascript;charset=utf-8';
		const specifier = JSON.stringify('/@npm/' + meta.specifier + '?asset');
		code = `import{style}from '/_wmr.js';\nstyle(${specifier});`;
	} else {
		type = getMimeType(meta.path);
		code = await loadPackageFile(meta);
	}
	res.writeHead(200, {
		'content-type': type || 'text/plain',
		'content-length': Buffer.byteLength(code)
	});
	res.end(code);
}

/**
 * @param {object} [options]
 * @param {'npm'|'unpkg'} [options.source = 'npm'] How to fetch package files
 * @param {Record<string,string>} [options.alias]
 * @param {boolean} [options.optimize = true] Progressively minify and compress dependency bundles?
 * @param {string} [options.cwd] Virtual cwd
 * @returns {import('polka').Middleware}
 */
export default function npmMiddleware({ source = 'npm', alias, optimize, cwd } = {}) {
	return async (req, res, next) => {
		const url = new URL(req.url, 'https://localhost');
		// @ts-ignore
		const mod = url.pathname.replace(/^\//, '');

		const meta = normalizeSpecifier(mod);

		try {
			await resolvePackageVersion(meta);
		} catch (e) {
			return next(e);
		}

		try {
			// The package name + path + version is a strong ETag since versions are immutable
			const etag = Buffer.from(`${meta.specifier}${meta.version}`).toString('base64');
			const ifNoneMatch = String(req.headers['if-none-match']).replace(/-(gz|br)$/g, '');
			if (ifNoneMatch === etag) {
				return res.writeHead(304).end();
			}
			res.setHeader('etag', etag);

			// CSS files and proxy modules don't use Rollup.
			if (/\.((css|s[ac]ss|less)|wasm|txt|json)$/.test(meta.path)) {
				return handleAsset(meta, res, url.searchParams.has('module'));
			}

			res.setHeader('content-type', 'application/javascript;charset=utf-8');
			if (hasDebugFlag()) {
				// eslint-disable-next-line no-console
				console.log(`  ${kl.dim('middleware:') + kl.bold(kl.magenta('npm'))}  ${JSON.stringify(meta.specifier)}`);
			}
			// serve from memory and disk caches:
			const cached = await getCachedBundle(etag, meta, cwd);
			if (cached) return sendCachedBundle(req, res, cached);

			// const start = Date.now();
			const code = await bundleNpmModule(mod, { source, alias, cwd });
			// console.log(`Bundle dep: ${mod}: ${Date.now() - start}ms`);

			// send it!
			res.writeHead(200, { 'content-length': Buffer.byteLength(code) }).end(code);

			// store the bundle in memory and disk caches
			setCachedBundle(etag, code, meta, cwd);

			// this is a new bundle, we'll compress it with terser and brotli shortly
			if (optimize !== false) {
				enqueueCompress(etag);
			}
		} catch (e) {
			console.error(`Error bundling ${mod}: `, e);
			next(e);
		}
	};
}

let npmCache;

/**
 * Bundle am npm module entry path into a single file
 * @param {string} mod The module to bundle, including subpackage/path
 * @param {object} options
 * @param {'npm'|'unpkg'} [options.source]
 * @param {Record<string,string>} options.alias
 * @param {string} options.cwd
 */
async function bundleNpmModule(mod, { source, alias, cwd }) {
	let npmProviderPlugin;

	if (source === 'unpkg') {
		throw Error('unpkg plugin is disabled');
		// npmProviderPlugin = unpkgPlugin({
		// 	publicPath: '/@npm',
		// 	perPackage: true
		// });
	} else {
		npmProviderPlugin = npmPlugin({
			publicPath: '/@npm'
		});
	}

	const bundle = await rollup.rollup({
		input: mod,
		onwarn: onWarn,
		// input: '\0entry',
		cache: npmCache,
		shimMissingExports: true,
		treeshake: false,
		// inlineDynamicImports: true,
		// shimMissingExports: true,
		preserveEntrySignatures: 'allow-extension',
		plugins: [
			nodeBuiltinsPlugin({}),
			aliasPlugin({ alias }),
			npmProviderPlugin,
			processGlobalPlugin({
				sourcemap: false,
				NODE_ENV: 'development'
			}),
			commonjs({
				extensions: ['.js', '.cjs', ''],
				sourceMap: false,
				transformMixedEsModules: true
			}),
			json(),
			{
				name: 'no-builtins',
				load(s) {
					if (s === 'fs' || s === 'path') {
						return 'export default {};';
					}
				}
			},
			wmrStylesPlugin({ alias, root: cwd, hot: false, production: true, sourcemap: false }),
			urlPlugin({ inline: false, root: cwd, alias }),
			defaultLoaders({ matchStyles: false }),
			{
				name: 'npm-asset',
				async transform(code, id) {
					if (!/\.([tj]sx?|mjs)$/.test(id)) return;

					return await transformImports(code, id, {
						resolveId(specifier) {
							if (!hasCustomPrefix(specifier) && (IMPLICIT_URL.test(specifier) || !/\.([sa]?css|less)$/.test(id))) {
								return `url:${specifier}`;
							}
							return null;
						}
					});
				}
				async load(id) {
					const file = path.join(cwd, id);
					if (file.startsWith(cwd)) {
						// return await fs$1.promises.readFile(file, 'utf-8');
						const spec = id.replace(/^\0?\.\.?\/node_modules/, '/@npm');
						return `export default "${spec}";`;
					} else {
						console.log('DONT LOAD', id);
					}
				}
			},
			{
				name: 'never-disk',
				load(s) {
					console.log('LOADING', JSON.stringify(s));
					throw Error('local access not allowed');
				}
			}
		]
	});

	npmCache = bundle.cache;

	const { output } = await bundle.generate({
		format: 'es',
		indent: false,
		// entryFileNames: '[name].js',
		// chunkFileNames: '[name].js',
		// Don't transform paths at all:
		paths: String
	});

	console.log(output);

	return output[0].code;
}
