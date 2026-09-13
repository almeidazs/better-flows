import { expect, test } from 'bun:test'

import { betterFlows, defineNode } from '../src'
import { memory } from '../src/runtimes/memory'

test('fails invalid retry configuration clearly', async () => {
	const invalid = defineNode<undefined, string>({
		id: 'invalid',
		retry: { attempts: 0 },
		run: () => 'never',
	})
	const flows = betterFlows({ runtime: memory(), nodes: { invalid } })
	const flow = flows.defineFlow<undefined, string>({
		id: 'invalid-retry',
		flow: ({ node }) => node(invalid, undefined),
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('failed')
	expect(result.error).toContain('retry.attempts')
})
