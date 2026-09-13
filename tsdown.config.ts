import { defineConfig } from 'tsdown'

export default defineConfig({
	clean: true,
	dts: true,
	entry: ['src/index.ts'],
	deps: { neverBundle: true },
	format: ['esm', 'cjs'],
	minify: false,
	outDir: 'dist',
	platform: 'neutral',
	sourcemap: true,
	target: 'es2022',
	treeshake: true,
})
