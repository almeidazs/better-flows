import { expect, test } from 'bun:test'

import { version } from '../src/index'

test('exposes the package version', () => {
	expect(version).toBe('0.1.0')
})
