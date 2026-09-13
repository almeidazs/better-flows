import { expect, test } from 'bun:test'

import { version } from '../src/index'
import { postgres } from '../src/runtimes/bullmq/postgres'

test('exposes the package version', () => {
	expect(version).toBe('0.1.0')
})

test('exposes the BullMQ PostgreSQL runtime', () => {
	expect(typeof postgres).toBe('function')
})
