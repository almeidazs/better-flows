import { defineConfig } from 'tsdown'

export default defineConfig({
	clean: true,
	dts: true,
	entry: {
		index: 'src/index.ts',
		'memory/index': 'src/runtimes/memory/index.ts',
		'bullmq/index': 'src/runtimes/bullmq/index.ts',
		'bullmq/postgres/index': 'src/runtimes/bullmq/postgres/index.ts',
		'cron/index': 'src/cron/index.ts',
		'triggers/index': 'src/triggers/index.ts',
	},
	deps: { neverBundle: true },
	format: ['esm', 'cjs'],
	minify: false,
	outDir: 'dist',
	platform: 'neutral',
	sourcemap: true,
	target: 'es2022',
	treeshake: true,
})
