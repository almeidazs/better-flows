import { expect, test } from 'bun:test'

import {
	betterFlows,
	defineNode,
	definePlugin,
	type NodeOutput,
	type Schema,
} from '../src'
import { memory } from '../src/runtimes/memory'

function schema<T>(): Schema<unknown, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate: (value) => ({ value: value as T }),
		},
	}
}

test('preserves schema output types for downstream code', () => {
	const enrich = defineNode({
		output: schema<{ leadId: string; company: string; score: number }>(),
		run: ({ input }: { input: { leadId: string } }) => ({
			leadId: input.leadId,
			company: 'Acme',
			score: 91,
		}),
	})
	const output: NodeOutput<typeof enrich> = {
		leadId: 'lead_123',
		company: 'Acme',
		score: 91,
	}
	// @ts-expect-error Output properties are validated by TypeScript before execution.
	void output.foo
	expect(output.score).toBe(91)
})

test('executes typed node dependencies and returns the flow output', async () => {
	const fetchLead = defineNode<
		{ leadId: string },
		{ leadId: string; score: number }
	>({
		id: 'fetchLead',
		input: schema(),
		output: schema(),
		run: ({ input }) => ({ leadId: input.leadId, score: 92 }),
	})
	const sendEmail = defineNode<
		{ leadId: string; score: number },
		{ delivered: boolean }
	>({
		id: 'sendEmail',
		run: ({ input }) => ({
			delivered: input.score > 80 && input.leadId.length > 0,
		}),
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { fetchLead, sendEmail },
	})
	const qualifyLead = flows.defineFlow<
		{ leadId: string },
		{ delivered: boolean }
	>({
		id: 'qualify-lead',
		input: schema(),
		output: schema(),
		flow: ({ input, node }) => {
			const lead = node(fetchLead, { leadId: input.leadId })
			return node(sendEmail, { leadId: lead.leadId, score: lead.score })
		},
	})
	const run = await qualifyLead.run({ leadId: 'lead_123' })
	const result = await run.wait()
	expect(result.status).toBe('completed')
	expect(result.output).toEqual({ delivered: true })
	expect(result.nodes.fetchLead?.output).toEqual({
		leadId: 'lead_123',
		score: 92,
	})
})

test('selects branches and skips the inactive branch', async () => {
	const score = defineNode<{ leadId: string }, 'high' | 'low'>({
		id: 'score',
		run: () => 'high',
	})
	const high = defineNode<undefined, string>({ id: 'high', run: () => 'sales' })
	const low = defineNode<undefined, string>({ id: 'low', run: () => 'nurture' })
	const flows = betterFlows({ runtime: memory(), nodes: { score, high, low } })
	const flow = flows.defineFlow<{ leadId: string }, string>({
		id: 'branch',
		flow: ({ input, node, branch }) => {
			const result = node(score, input)
			branch(result, {
				high: () => {
					node(high, undefined)
				},
				low: () => {
					node(low, undefined)
				},
			})
			return result
		},
	})
	const result = await (await flow.run({ leadId: '1' })).wait()
	expect(result.nodes.high?.status).toBe('completed')
	expect(result.nodes.low?.status).toBe('skipped')
})

test('uses the default branch when no explicit case matches', async () => {
	const score = defineNode<undefined, string>({
		id: 'score',
		run: () => 'medium',
	})
	const fallback = defineNode<undefined, string>({
		id: 'fallback',
		run: () => 'nurture',
	})
	const flows = betterFlows({ runtime: memory(), nodes: { score, fallback } })
	const flow = flows.defineFlow<undefined, string>({
		id: 'default-branch',
		flow: ({ node, branch }) => {
			const result = node(score, undefined)
			branch(result, {
				high: () => {},
				default: () => {
					node(fallback, undefined)
				},
			})
			return result
		},
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.nodes.fallback?.status).toBe('completed')
})

test('selects the first matching predicate branch and supports switch', async () => {
	const score = defineNode<undefined, number>({ id: 'score', run: () => 65 })
	const warm = defineNode<undefined, string>({ id: 'warm', run: () => 'warm' })
	const hot = defineNode<undefined, string>({ id: 'hot', run: () => 'hot' })
	const flows = betterFlows({ runtime: memory(), nodes: { score, warm, hot } })
	const flow = flows.defineFlow<undefined, undefined>({
		id: 'predicate-branch',
		flow: ({ node, branch }) => {
			const value = node(score, undefined)
			branch(
				value,
				{
					hot: ({ value: current }) => current >= 80,
					warm: ({ value: current }) => current >= 40,
				},
				{ hot: () => node(hot, undefined), warm: () => node(warm, undefined) },
			)
			return undefined
		},
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.nodes.warm?.status).toBe('completed')
	expect(result.nodes.hot?.status).toBe('skipped')
})

test('maps runtime output into typed fan-out and ordered fan-in', async () => {
	const findCompanies = defineNode<undefined, { id: string }[]>({
		id: 'find-companies',
		run: () => [{ id: '1' }, { id: '2' }, { id: '3' }],
	})
	const enrichCompany = defineNode<
		{ companyId: string },
		{ id: string; name: string }
	>({
		id: 'enrich-company',
		run: ({ input }) => ({
			id: input.companyId,
			name: `Company ${input.companyId}`,
		}),
	})
	const report = defineNode<
		{ companies: { id: string; name: string }[] },
		string
	>({
		id: 'report',
		run: ({ input }) => input.companies.map((company) => company.id).join(','),
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { findCompanies, enrichCompany, report },
	})
	const flow = flows.defineFlow<undefined, string>({
		id: 'map-companies',
		flow: ({ node, map }) => {
			const companies = node(findCompanies, undefined)
			const enriched = map(companies, (company) =>
				node(enrichCompany, { companyId: company.id }),
			)
			return node(report, { companies: enriched })
		},
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.output).toBe('1,2,3')
	expect(result.nodes['map-1[0].enrich-company']?.status).toBe('completed')
	expect(result.nodes['map-1[2].enrich-company']?.output).toEqual({
		id: '3',
		name: 'Company 3',
	})
})

test('limits map concurrency', async () => {
	let active = 0
	let maximum = 0
	const values = defineNode<undefined, number[]>({
		id: 'values',
		run: () => [1, 2, 3, 4],
	})
	const work = defineNode<number, number>({
		id: 'work',
		run: async ({ input }) => {
			active++
			maximum = Math.max(maximum, active)
			await new Promise((resolve) => setTimeout(resolve, 5))
			active--
			return input
		},
	})
	const flows = betterFlows({ runtime: memory(), nodes: { values, work } })
	const flow = flows.defineFlow<undefined, number[]>({
		id: 'map-concurrency',
		flow: ({ node, map }) =>
			map(node(values, undefined), (value) => node(work, value), {
				concurrency: 2,
			}),
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.output).toEqual([1, 2, 3, 4])
	expect(maximum).toBe(2)
})

test('executes typed loop state transitions until the condition is false', async () => {
	const advance = defineNode<
		{ readonly attempts: number },
		{ readonly attempts: number }
	>({
		id: 'advance',
		run: ({ input }) => ({ attempts: input.attempts + 1 }),
	})
	const flows = betterFlows({ runtime: memory(), nodes: { advance } })
	const flow = flows.defineFlow<undefined, { readonly attempts: number }>({
		id: 'loop-state',
		flow: ({ loop }) =>
			loop({
				initial: { attempts: 0 },
				while: (state) => state.attempts < 3,
				run: ({ state, node }) => node(advance, state),
			}),
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('completed')
	expect(result.output).toEqual({ attempts: 3 })
	expect(result.nodes['loop-1[0].advance']?.status).toBe('completed')
	expect(result.nodes['loop-1[2].advance']?.output).toEqual({ attempts: 3 })
})

test('supports map inside a loop iteration', async () => {
	const source = defineNode<
		{ readonly values: readonly number[] },
		readonly number[]
	>({
		id: 'source',
		run: ({ input }) => input.values,
	})
	const double = defineNode<number, number>({
		id: 'double',
		run: ({ input }) => input * 2,
	})
	const next = defineNode<
		{ readonly attempts: number; readonly values: readonly number[] },
		{ readonly attempts: number; readonly values: readonly number[] }
	>({
		id: 'next',
		run: ({ input }) => ({ ...input, attempts: input.attempts + 1 }),
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { source, double, next },
	})
	const flow = flows.defineFlow<
		undefined,
		{ readonly attempts: number; readonly values: readonly number[] }
	>({
		id: 'loop-map',
		flow: ({ loop }) =>
			loop({
				initial: { attempts: 0, values: [1, 2] as readonly number[] },
				while: (state) => state.attempts < 1,
				run: ({ state, node, map }) => {
					const values = node(source, { values: state.values })
					const doubled = map(values, (value) => node(double, value))
					return node(next, { attempts: state.attempts, values: doubled })
				},
			}),
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('completed')
	expect(result.output).toEqual({ attempts: 1, values: [2, 4] })
})

test('fails loops that exceed their maximum and rejects nested loops', async () => {
	const same = defineNode<number, number>({
		id: 'same',
		run: ({ input }) => input,
	})
	const flows = betterFlows({ runtime: memory(), nodes: { same } })
	const limited = flows.defineFlow<undefined, number>({
		id: 'limited-loop',
		flow: ({ loop }) =>
			loop({
				initial: 0,
				while: () => true,
				maxIterations: 2,
				run: ({ state, node }) => node(same, state),
			}),
	})
	const result = await (await limited.run(undefined)).wait()
	expect(result.status).toBe('failed')
	expect(result.error).toContain('exceeded its maximum of 2')
	expect(result.nodes['loop-1']?.status).toBe('failed')
	expect(result.nodes['loop-1']?.attempts).toBe(2)
	expect(() =>
		flows.defineFlow<undefined, number>({
			id: 'nested-loop',
			flow: ({ loop }) =>
				loop({
					initial: 0,
					while: () => false,
					run: () =>
						loop({
							initial: 0,
							while: () => false,
							run: ({ state, node }) => node(same, state),
						}),
				}),
		}),
	).toThrow('cannot be nested')
	expect(() =>
		flows.defineFlow<number[], number[]>({
			id: 'loop-in-map',
			flow: ({ input, loop, map }) =>
				map(input, () =>
					loop({
						initial: 0,
						while: () => false,
						run: ({ state, node }) => node(same, state),
					}),
				),
		}),
	).toThrow('loop() cannot be declared inside map()')
})

test('respects conditional paths around loops', async () => {
	const increment = defineNode<number, number>({
		id: 'increment',
		run: ({ input }) => input + 1,
	})
	const flows = betterFlows({ runtime: memory(), nodes: { increment } })
	const flow = flows.defineFlow<{ readonly enabled: boolean }, number>({
		id: 'conditional-loop',
		flow: ({ input, loop, when }) => {
			let result = 0 as number
			when(input.enabled, () => {
				result = loop({
					initial: 0,
					while: (state) => state < 1,
					run: ({ state, node }) => node(increment, state),
				})
			})
			return result
		},
	})
	const result = await (await flow.run({ enabled: false })).wait()
	expect(result.status).toBe('completed')
	expect(result.nodes['loop-1']?.status).toBe('skipped')
})

test('retries transient node failures', async () => {
	let attempts = 0
	const events: string[] = []
	const flaky = defineNode<undefined, string>({
		id: 'flaky',
		retry: { attempts: 2, backoff: 'fixed' },
		run: () => {
			attempts++
			if (attempts === 1) throw new Error('temporary')
			return 'ok'
		},
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { flaky },
		hooks: {
			onNodeStart: ({ attempt }) => events.push(`start:${attempt}`),
			onNodeError: ({ attempt, willRetry }) =>
				events.push(`error:${attempt}:${willRetry}`),
			onNodeRetry: ({ attempt, delay }) =>
				events.push(`retry:${attempt}:${delay}`),
			onNodeComplete: ({ node }) => events.push(`complete:${node.attempts}`),
			onNodeFinish: ({ node }) => events.push(`finish:${node.status}`),
		},
	})
	const flow = flows.defineFlow<undefined, string>({
		id: 'retry',
		flow: ({ node }) => node(flaky, undefined),
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('completed')
	expect(result.nodes.flaky?.attempts).toBe(2)
	expect(events).toEqual([
		'start:1',
		'error:1:true',
		'retry:1:1000',
		'start:2',
		'complete:2',
		'finish:completed',
	])
})

test('invokes native and plugin hooks and exposes a running snapshot', async () => {
	const events: string[] = []
	const slow = defineNode<undefined, string>({
		id: 'slow',
		input: schema(),
		output: schema(),
		run: async ({ ctx }) => {
			events.push(`${ctx.nodeId}:run`)
			await new Promise((resolve) => setTimeout(resolve, 10))
			return 'done'
		},
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { slow },
		hooks: {
			onRunStart: ({ runId }) => {
				events.push(`start:${runId}`)
			},
			onNodeStart: ({ nodeId }) => {
				events.push(`${nodeId}:start`)
			},
			onRunFinish: ({ run }) => {
				events.push(`finish:${run.status}`)
			},
		},
		plugins: [
			definePlugin({
				name: 'audit',
				context: () => ({ source: 'plugin' as const }),
				hooks: {
					onNodeComplete: ({ nodeId, nodeCtx }) => {
						events.push(`${nodeId}:complete:${nodeCtx.audit.source}`)
					},
				},
			}),
		] as const,
	})
	const flow = flows.defineFlow<undefined, string>({
		id: 'hooks',
		flow: ({ node }) => node(slow, undefined),
	})
	const run = await flow.run(undefined)
	const snapshot = await flows.runs.get(run.id)
	expect(snapshot.status).toBe('running')
	const output: string | undefined = snapshot.nodes.slow.output
	expect(output).toBeUndefined()
	expect((await run.wait()).output).toBe('done')
	expect(events.some((event) => event === 'slow:start')).toBe(true)
	expect(events.some((event) => event === 'slow:complete:plugin')).toBe(true)
	expect(events.some((event) => event === 'finish:completed')).toBe(true)
})

test('fails a timed out node and does not run dependants', async () => {
	let dependantRan = false
	const events: string[] = []
	const slow = defineNode<undefined, string>({
		id: 'slow',
		timeout: '1ms',
		retry: false,
		run: () => new Promise((resolve) => setTimeout(() => resolve('late'), 25)),
	})
	const dependant = defineNode<string, string>({
		id: 'dependant',
		run: () => {
			dependantRan = true
			return 'unexpected'
		},
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { slow, dependant },
		hooks: {
			onNodeError: ({ error, willRetry }) =>
				events.push(
					`error:${error instanceof Error ? error.message : error}:${willRetry}`,
				),
			onNodeFail: ({ nodeId }) => events.push(`fail:${nodeId}`),
			onNodeFinish: ({ node }) => events.push(`finish:${node.status}`),
			onRunFail: ({ error }) =>
				events.push(`run:${error instanceof Error ? error.message : error}`),
			onRunFinish: ({ run }) => events.push(`run-finish:${run.status}`),
		},
	})
	const flow = flows.defineFlow<undefined, string>({
		id: 'timeout',
		flow: ({ node }) => node(dependant, node(slow, undefined)),
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('failed')
	expect(result.nodes.slow?.status).toBe('failed')
	expect(dependantRan).toBe(false)
	expect(events).toEqual([
		'error:Node "slow" timed out.:false',
		'fail:slow',
		'finish:failed',
		'run:Node "slow" timed out.',
		'run-finish:failed',
	])
})

test('rejects branch values that are not workflow references', () => {
	const flows = betterFlows({ runtime: memory(), nodes: {} })
	expect(() =>
		flows.defineFlow<undefined, undefined>({
			id: 'invalid-branch',
			flow: ({ branch }) => {
				branch('high', { high: () => {} })
				return undefined
			},
		}),
	).toThrow('branch() requires')
})

test('runs independent nodes concurrently and supports when()', async () => {
	const started: string[] = []
	const gate = defineNode<undefined, boolean>({ id: 'gate', run: () => true })
	const first = defineNode<undefined, string>({
		id: 'first',
		run: async () => {
			started.push('first')
			await new Promise((resolve) => setTimeout(resolve, 10))
			return 'first'
		},
	})
	const second = defineNode<undefined, string>({
		id: 'second',
		run: () => {
			started.push('second')
			return 'second'
		},
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { gate, first, second },
	})
	const flow = flows.defineFlow<undefined, undefined>({
		id: 'parallel',
		flow: ({ node, parallel, when }) => {
			parallel(() => {
				node(first, undefined)
				node(second, undefined)
			})
			when(node(gate, undefined), () => {
				node(second, undefined)
			})
			return undefined
		},
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('completed')
	expect(started.slice(0, 2).sort()).toEqual(['first', 'second'])
	expect(result.nodes['second#2']?.status).toBe('completed')
})

test('starts dependants as soon as their own dependency completes', async () => {
	const events: string[] = []
	const slow = defineNode<undefined, string>({
		id: 'slow',
		run: async () => {
			events.push('slow:start')
			await new Promise((resolve) => setTimeout(resolve, 20))
			events.push('slow:end')
			return 'slow'
		},
	})
	const fast = defineNode<undefined, string>({
		id: 'fast',
		run: async () => {
			await new Promise((resolve) => setTimeout(resolve, 2))
			events.push('fast:end')
			return 'fast'
		},
	})
	const dependant = defineNode<string, string>({
		id: 'dependant',
		run: ({ input }) => {
			events.push('dependant:start')
			return input
		},
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { slow, fast, dependant },
	})
	const flow = flows.defineFlow<undefined, undefined>({
		id: 'event-driven-parallelism',
		flow: ({ node }) => {
			node(slow, undefined)
			node(dependant, node(fast, undefined))
			return undefined
		},
	})
	await (await flow.run(undefined)).wait()
	expect(events.indexOf('dependant:start')).toBeLessThan(
		events.indexOf('slow:end'),
	)
})

test('cancels a cooperative running node', async () => {
	const events: string[] = []
	const waiting = defineNode<undefined, string>({
		id: 'waiting',
		run: ({ ctx }) =>
			new Promise((_, reject) =>
				ctx.signal.addEventListener('abort', () =>
					reject(new DOMException('cancelled', 'AbortError')),
				),
			),
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { waiting },
		hooks: {
			onNodeCancel: ({ nodeId }) => events.push(`node:${nodeId}`),
			onNodeFinish: ({ node }) => events.push(`finish:${node.status}`),
			onRunCancel: () => events.push('run'),
			onRunFinish: ({ run }) => events.push(`run-finish:${run.status}`),
		},
	})
	const flow = flows.defineFlow<undefined, string>({
		id: 'cancel',
		flow: ({ node }) => node(waiting, undefined),
	})
	const run = await flow.run(undefined)
	await run.cancel()
	const result = await run.wait()
	expect(result.status).toBe('cancelled')
	expect(result.nodes.waiting?.status).toBe('cancelled')
	expect(events).toEqual([
		'node:waiting',
		'finish:cancelled',
		'run',
		'run-finish:cancelled',
	])
})

test('reports skipped nodes and hook errors without changing the run outcome', async () => {
	const events: string[] = []
	const source = defineNode<undefined, boolean>({
		id: 'source',
		run: () => false,
	})
	const skipped = defineNode<undefined, undefined>({
		id: 'skipped',
		run: () => undefined,
	})
	const flows = betterFlows({
		runtime: memory(),
		nodes: { source, skipped },
		hooks: {
			onNodeComplete: () => {
				throw new Error('metrics unavailable')
			},
			onNodeSkip: ({ nodeId }) => events.push(`skip:${nodeId}`),
			onNodeFinish: ({ node }) => events.push(`finish:${node.status}`),
			onHookError: ({ hook, error }) =>
				events.push(
					`${hook}:${error instanceof Error ? error.message : error}`,
				),
		},
	})
	const flow = flows.defineFlow<undefined, undefined>({
		id: 'hook-errors',
		flow: ({ node, when }) => {
			when(node(source, undefined), () => node(skipped, undefined))
			return undefined
		},
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('completed')
	expect(events).toEqual([
		'onNodeComplete:metrics unavailable',
		'finish:completed',
		'skip:skipped',
		'finish:skipped',
	])
})

test('settles invalid flow input as a failed run and calls finish hooks', async () => {
	const events: string[] = []
	const invalidInput: Schema<unknown, undefined> = {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate: () =>
				({ issues: [{ message: 'leadId is required' }] }) as never,
		},
	}
	const flows = betterFlows({
		runtime: memory(),
		nodes: {},
		hooks: {
			onRunFinish: ({ run }) => {
				events.push(run.status)
			},
		},
	})
	const flow = flows.defineFlow<undefined, undefined>({
		id: 'invalid-input',
		input: invalidInput,
		flow: () => undefined,
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('failed')
	expect(result.error).toContain('leadId is required')
	expect(events).toEqual(['failed'])
})

test('settles context initialization failures and reports their original error', async () => {
	const events: string[] = []
	const flows = betterFlows({
		runtime: memory(),
		nodes: {},
		context: () => {
			throw new Error('database unavailable')
		},
		hooks: {
			onRunStart: () => events.push('start'),
			onRunFail: ({ error }) =>
				events.push(error instanceof Error ? error.message : String(error)),
			onRunFinish: ({ run }) => events.push(`finish:${run.status}`),
		},
	})
	const flow = flows.defineFlow<undefined, undefined>({
		id: 'context-failure',
		flow: () => undefined,
	})
	const result = await (await flow.run(undefined)).wait()
	expect(result.status).toBe('failed')
	expect(result.error).toBe('database unavailable')
	expect(events).toEqual(['database unavailable', 'finish:failed'])
})
