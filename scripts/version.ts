import { readFile, writeFile } from 'node:fs/promises'

const { name, version } = JSON.parse(
	await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string }

await writeFile(
	new URL('../src/version.ts', import.meta.url),
	`/** Your current version of [${name}](https://www.npmjs.com/package/${name}). */\nexport const version = '${version}'\n`,
)
