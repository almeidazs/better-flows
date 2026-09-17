import {
	createReference,
	dependencies,
	duration,
	type EngineHooks,
	getReference,
	type Plan,
	type Reference,
	referenceBrand,
	resolve,
	type Step,
	validate,
} from '../internal'
import type { NodeRun, RunSnapshot } from './index'

function snapshot(
	id: string,
	status: RunSnapshot['status'],
	nodes: Map<string, NodeRun>,
	output?: unknown,
	error?: string,
	trigger?: RunSnapshot['trigger'],
): RunSnapshot {
	return {
		id,
		status,
		...(output === undefined ? {} : { output }),
		...(error ? { error } : {}),
		...(trigger ? { trigger } : {}),
		nodes: Object.fromEntries(nodes),
	}
}

function nodeRun(nodes: ReadonlyMap<string, NodeRun>, id: string): NodeRun {
	const node = nodes.get(id)

	if (!node) throw new Error(`Node "${id}" is not part of this execution.`)

	return node
}

function remapMapValue(
	value: unknown,
	item: unknown,
	index: number,
	ids: ReadonlyMap<string, string>,
): unknown {
	const reference = getReference(value)
	if (reference) {
		const { nodeId, path } = reference[referenceBrand]
		if (nodeId === '$map:item')
			return path.reduce<unknown>(
				(current, property) =>
					current === null || current === undefined
						? undefined
						: (current as Record<PropertyKey, unknown>)[property],
				item,
			)
		if (nodeId === '$map:index') return index
		const id = ids.get(nodeId)
		return id ? createReference(id, path) : value
	}
	if (Array.isArray(value))
		return value.map((entry) => remapMapValue(entry, item, index, ids))
	if (
		typeof value !== 'object' ||
		value === null ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		return value
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			remapMapValue(entry, item, index, ids),
		]),
	)
}

function loopValue(
	value: unknown,
	state: unknown,
	iteration: number,
	ids: ReadonlyMap<string, string>,
	preserved = new Set<string>(),
): unknown {
	const reference = getReference(value)
	if (reference) {
		const { nodeId, path } = reference[referenceBrand]
		if (nodeId === '$loop:state')
			return path.reduce<unknown>(
				(current, property) =>
					current === null || current === undefined
						? undefined
						: (current as Record<PropertyKey, unknown>)[property],
				state,
			)
		if (nodeId === '$loop:iteration') return iteration
		if (preserved.has(nodeId)) return value
		const id = ids.get(nodeId)
		return id ? createReference(id, path) : value
	}
	if (Array.isArray(value))
		return value.map((entry) =>
			loopValue(entry, state, iteration, ids, preserved),
		)
	if (
		typeof value !== 'object' ||
		value === null ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		return value
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			loopValue(entry, state, iteration, ids, preserved),
		]),
	)
}

function expandLoop(
	loop: Plan['loops'][number],
	state: unknown,
	iteration: number,
): { steps: Step[]; maps: Plan['maps']; result: unknown; prefix: string } {
	const prefix = `${loop.id}[${iteration}]`
	const ids = new Map<string, string>([
		...loop.steps.map((step) => [step.id, `${prefix}.${step.id}`] as const),
		...loop.maps.map((map) => [map.id, `${prefix}.${map.id}`] as const),
	])
	const steps = loop.steps.map((step) => {
		const id = ids.get(step.id)
		if (!id) throw new Error(`Loop "${loop.id}" generated an invalid step ID.`)
		return {
			...step,
			id,
			input: loopValue(step.input, state, iteration, ids),
			conditions: step.conditions.map((condition) => ({
				...condition,
				value: loopValue(condition.value, state, iteration, ids) as Reference,
			})),
		}
	})
	const maps = loop.maps.map((map) => {
		const localIds = new Set(map.steps.map((step) => step.id))
		const id = ids.get(map.id)
		if (!id) throw new Error(`Loop "${loop.id}" generated an invalid map ID.`)
		return {
			...map,
			id,
			items: loopValue(map.items, state, iteration, ids),
			steps: map.steps.map((step) => ({
				...step,
				input: loopValue(step.input, state, iteration, ids, localIds),
				conditions: step.conditions.map((condition) => ({
					...condition,
					value: loopValue(
						condition.value,
						state,
						iteration,
						ids,
						localIds,
					) as Reference,
				})),
			})),
		}
	})
	return {
		steps,
		maps,
		result: loopValue(loop.result, state, iteration, ids),
		prefix,
	}
}

function expandMap(
	map: Plan['maps'][number],
	items: readonly unknown[],
): Step[] {
	const expanded: Step[] = []
	const results: Reference[] = []
	for (const [index, item] of items.entries()) {
		const ids = new Map(
			map.steps.map((step) => [step.id, `${map.id}[${index}].${step.id}`]),
		)
		for (const step of map.steps) {
			const id = ids.get(step.id)
			if (!id) continue
			expanded.push({
				...step,
				id,
				map: {
					id: map.id,
					...(map.concurrency === undefined
						? {}
						: { concurrency: map.concurrency }),
				},
				input: remapMapValue(step.input, item, index, ids),
				conditions: step.conditions.map((condition) => ({
					...condition,
					value: remapMapValue(condition.value, item, index, ids) as Reference,
				})),
			})
		}
		const result = getReference(remapMapValue(map.result, item, index, ids))
		if (!result)
			throw new Error(`map "${map.id}" produced an invalid item result.`)
		results.push(result)
	}
	expanded.push({
		id: map.id,
		internal: true,
		node: {
			id: map.id,
			retry: false,
			run: ({ input }) => input,
		},
		input: results,
		conditions: [],
	})
	return expanded
}

function isSelected(
	step: Pick<Step, 'conditions'>,
	outputs: ReadonlyMap<string, unknown>,
): boolean {
	return step.conditions.every(
		({ value, expected, otherwise, predicate, previousPredicates }) => {
			const resolved = resolve(value, outputs)

			if (predicate)
				return (
					predicate(resolved) &&
					!previousPredicates?.some((previous) => previous(resolved))
				)

			return otherwise
				? !otherwise.includes(resolved as PropertyKey)
				: resolved === expected
		},
	)
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveSleep, reject) => {
		const timer = setTimeout(resolveSleep, milliseconds)
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer)
				reject(new DOMException('Run cancelled', 'AbortError'))
			},
			{ once: true },
		)
	})
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeout: string | number | undefined,
	controller: AbortController,
	nodeId: string,
): Promise<T> {
	if (timeout === undefined) return promise
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort()
					reject(new Error(`Node "${nodeId}" timed out.`))
				}, duration(timeout))
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function retryPolicy(step: Step): {
	attempts: number
	backoff: 'exponential' | 'fixed'
} {
	if (step.node.retry === false) return { attempts: 1, backoff: 'fixed' }
	const attempts = step.node.retry?.attempts ?? 3
	if (!Number.isSafeInteger(attempts) || attempts < 1)
		throw new TypeError(
			`Node "${step.id}" retry.attempts must be a positive integer.`,
		)
	return {
		attempts,
		backoff: step.node.retry?.backoff ?? 'exponential',
	}
}

export async function executePlan(
	id: string,
	plan: Plan,
	input: unknown,
	context: Record<string, unknown>,
	update: (snapshot: RunSnapshot) => Promise<void> | void,
	signal: AbortSignal,
	hooks?: EngineHooks,
	trigger?: RunSnapshot['trigger'],
): Promise<RunSnapshot> {
	const nodes = new Map<string, NodeRun>([
		...plan.steps.map(
			(step) => [step.id, { status: 'pending', attempts: 0 }] as const,
		),
		...plan.loops.map(
			(loop) => [loop.id, { status: 'pending', attempts: 0 }] as const,
		),
	])
	const outputs = new Map<string, unknown>()
	const remaining = new Set(plan.steps.map((step) => step.id))
	const byId = new Map(plan.steps.map((step) => [step.id, step]))
	const remainingMaps = new Map(plan.maps.map((map) => [map.id, map]))
	const remainingLoops = new Map(plan.loops.map((loop) => [loop.id, loop]))
	const activeLoops = new Map<
		string,
		{
			readonly iteration: number
			readonly prefix: string
			readonly result: unknown
		}
	>()
	const active = new Map<Promise<void>, Step>()
	const activeMaps = new Map<string, number>()
	const publish = async (status: RunSnapshot['status'] = 'running') =>
		update(snapshot(id, status, nodes, undefined, undefined, trigger))
	await publish()
	const runStep = async (step: Step) => {
		const nodeContext = {
			...context,
			flowId: plan.id,
			nodeId: step.id,
			runId: id,
			signal,
		}
		const nodeInput = resolve(step.input, outputs)
		const finish = async () => {
			if (step.internal) return
			await hooks?.onNodeFinish?.({
				runId: id,
				flowId: plan.id,
				input,
				ctx: context,
				nodeId: step.id,
				nodeInput,
				nodeCtx: nodeContext,
				node: nodeRun(nodes, step.id),
			})
		}
		if (!isSelected(step, outputs)) {
			nodes.set(step.id, { status: 'skipped', attempts: 0 })
			if (!step.internal)
				await hooks?.onNodeSkip?.({
					runId: id,
					flowId: plan.id,
					input,
					ctx: context,
					nodeId: step.id,
					nodeInput,
					nodeCtx: nodeContext,
					node: nodeRun(nodes, step.id),
				})
			await finish()
			return
		}
		const retry = retryPolicy(step)
		let lastError: unknown
		for (let attempt = 1; attempt <= retry.attempts; attempt++) {
			if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError')
			nodes.set(step.id, { status: 'running', attempts: attempt })
			await publish()
			const controller = new AbortController()
			const attemptContext = {
				...context,
				flowId: plan.id,
				nodeId: step.id,
				runId: id,
				signal: controller.signal,
			}
			signal.addEventListener('abort', () => controller.abort(), {
				once: true,
			})
			if (signal.aborted) controller.abort()
			try {
				if (!step.internal)
					await hooks?.onNodeStart?.({
						runId: id,
						flowId: plan.id,
						input,
						ctx: context,
						nodeId: step.id,
						nodeInput,
						nodeCtx: attemptContext,
						attempt,
						maxAttempts: retry.attempts,
					})
				const run = Promise.resolve(
					step.node.run({
						input: await validate(step.node.input, nodeInput),
						ctx: attemptContext,
					}),
				)
				const output = await withTimeout(
					run,
					step.node.timeout,
					controller,
					step.id,
				)
				const validatedOutput = await validate(step.node.output, output)
				outputs.set(step.id, validatedOutput)
				nodes.set(step.id, {
					status: 'completed',
					attempts: attempt,
					output: validatedOutput,
				})
				if (!step.internal)
					await hooks?.onNodeComplete?.({
						runId: id,
						flowId: plan.id,
						input,
						ctx: context,
						nodeId: step.id,
						nodeInput,
						nodeCtx: attemptContext,
						node: nodeRun(nodes, step.id),
						output: validatedOutput,
					})
				await finish()
				return
			} catch (error) {
				lastError = error
				if (signal.aborted) throw error
				const willRetry = !controller.signal.aborted && attempt < retry.attempts
				const delay =
					(retry.backoff === 'exponential' ? 2 ** (attempt - 1) : 1) * 1_000
				if (!step.internal)
					await hooks?.onNodeError?.({
						runId: id,
						flowId: plan.id,
						input,
						ctx: context,
						nodeId: step.id,
						nodeInput,
						nodeCtx: attemptContext,
						attempt,
						maxAttempts: retry.attempts,
						error,
						willRetry,
					})
				if (controller.signal.aborted) break
				if (willRetry) {
					if (!step.internal)
						await hooks?.onNodeRetry?.({
							runId: id,
							flowId: plan.id,
							input,
							ctx: context,
							nodeId: step.id,
							nodeInput,
							nodeCtx: attemptContext,
							attempt,
							maxAttempts: retry.attempts,
							error,
							willRetry,
							delay,
						})
					await sleep(delay, signal)
				}
			}
		}
		nodes.set(step.id, {
			status: 'failed',
			attempts: retry.attempts,
			error: lastError instanceof Error ? lastError.message : String(lastError),
		})
		if (!step.internal)
			await hooks?.onNodeFail?.({
				runId: id,
				flowId: plan.id,
				input,
				ctx: context,
				nodeId: step.id,
				nodeInput,
				nodeCtx: nodeContext,
				node: nodeRun(nodes, step.id),
				error: lastError,
			})
		await finish()
		throw lastError
	}

	const dependenciesComplete = (value: unknown) =>
		[...dependencies(value)].every(
			(dependency) =>
				dependency === '$input' ||
				nodes.get(dependency)?.status === 'completed',
		)
	const scheduleLoop = (
		loop: Plan['loops'][number],
		state: unknown,
		iteration: number,
	) => {
		nodes.set(loop.id, { status: 'running', attempts: iteration })
		if (!loop.while(state)) {
			outputs.set(loop.id, state)
			nodes.set(loop.id, {
				status: 'completed',
				attempts: iteration,
				output: state,
			})
			return
		}
		if (iteration >= loop.maxIterations) {
			const error = `Loop "${loop.id}" exceeded its maximum of ${loop.maxIterations} iterations.`
			nodes.set(loop.id, { status: 'failed', attempts: iteration, error })
			throw new Error(error)
		}
		const expanded = expandLoop(loop, state, iteration)
		for (const step of expanded.steps) {
			if (byId.has(step.id))
				throw new Error(`Loop "${loop.id}" generated a duplicate step ID.`)
			byId.set(step.id, step)
			remaining.add(step.id)
			nodes.set(step.id, { status: 'pending', attempts: 0 })
		}
		for (const map of expanded.maps) {
			if (remainingMaps.has(map.id))
				throw new Error(`Loop "${loop.id}" generated a duplicate map ID.`)
			remainingMaps.set(map.id, map)
		}
		activeLoops.set(loop.id, {
			iteration,
			prefix: expanded.prefix,
			result: expanded.result,
		})
	}

	try {
		outputs.set('$input', await validate(plan.input, input))
		while (
			remaining.size > 0 ||
			remainingMaps.size > 0 ||
			remainingLoops.size > 0 ||
			activeLoops.size > 0 ||
			active.size > 0
		) {
			if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError')
			for (const [loopId, loop] of remainingLoops) {
				if (
					!dependenciesComplete(loop.initial) ||
					!loop.conditions.every((condition) =>
						dependenciesComplete(condition.value),
					)
				)
					continue
				remainingLoops.delete(loopId)
				if (!isSelected({ conditions: loop.conditions }, outputs)) {
					nodes.set(loop.id, { status: 'skipped', attempts: 0 })
					continue
				}
				scheduleLoop(loop, resolve(loop.initial, outputs), 0)
			}
			for (const [loopId, activeLoop] of activeLoops) {
				const busy =
					[...remaining].some((id) => id.startsWith(`${activeLoop.prefix}.`)) ||
					[...active.values()].some((step) =>
						step.id.startsWith(`${activeLoop.prefix}.`),
					) ||
					[...remainingMaps.keys()].some((id) =>
						id.startsWith(`${activeLoop.prefix}.`),
					)
				if (busy) continue
				const loop = plan.loops.find((candidate) => candidate.id === loopId)
				if (!loop) throw new Error(`Loop "${loopId}" was not found.`)
				activeLoops.delete(loopId)
				scheduleLoop(
					loop,
					resolve(activeLoop.result, outputs),
					activeLoop.iteration + 1,
				)
			}
			for (const [mapId, map] of remainingMaps) {
				if (!dependenciesComplete(map.items)) continue
				const items = resolve(map.items, outputs)
				if (!Array.isArray(items))
					throw new TypeError(`map "${mapId}" source must resolve to an array.`)
				remainingMaps.delete(mapId)
				for (const step of expandMap(map, items)) {
					if (byId.has(step.id))
						throw new Error(`map "${mapId}" generated a duplicate step ID.`)
					byId.set(step.id, step)
					remaining.add(step.id)
					nodes.set(step.id, { status: 'pending', attempts: 0 })
				}
			}
			if (
				remaining.size === 0 &&
				remainingMaps.size === 0 &&
				remainingLoops.size === 0 &&
				activeLoops.size === 0 &&
				active.size === 0
			)
				break
			const ready = [...remaining]
				.map((stepId) => byId.get(stepId))
				.filter((step): step is Step => Boolean(step))
				.filter(
					(step) =>
						dependenciesComplete(step.input) &&
						step.conditions.every((condition) =>
							dependenciesComplete(condition.value),
						),
				)
			const mapSlots = new Map(activeMaps)
			const limitedReady = ready.filter((step) => {
				if (!step.map?.concurrency) return true
				const count = mapSlots.get(step.map.id) ?? 0
				if (count >= step.map.concurrency) return false
				mapSlots.set(step.map.id, count + 1)
				return true
			})
			if (limitedReady.length === 0 && active.size === 0)
				throw new Error('Flow graph has unresolved or circular dependencies.')
			for (const step of limitedReady) {
				remaining.delete(step.id)
				const task = runStep(step)
				active.set(task, step)
				if (step.map?.concurrency)
					activeMaps.set(step.map.id, (activeMaps.get(step.map.id) ?? 0) + 1)
			}
			const settled = await Promise.race(
				[...active].map(async ([task, step]) => {
					try {
						await task
						return { task, step }
					} catch (error) {
						return { task, step, error }
					}
				}),
			)
			active.delete(settled.task)
			if (settled.step.map?.concurrency) {
				const count = (activeMaps.get(settled.step.map.id) ?? 1) - 1
				if (count === 0) activeMaps.delete(settled.step.map.id)
				else activeMaps.set(settled.step.map.id, count)
			}
			if ('error' in settled) {
				await Promise.allSettled([...active.keys()])
				throw settled.error
			}
			await publish()
		}
		const output = await validate(plan.output, resolve(plan.result, outputs))
		const result = snapshot(id, 'completed', nodes, output, undefined, trigger)
		await update(result)
		return result
	} catch (error) {
		const cancelled =
			signal.aborted ||
			(error instanceof DOMException && error.name === 'AbortError')
		if (!cancelled)
			for (const [loopId, activeLoop] of activeLoops) {
				const node = nodeRun(nodes, loopId)
				if (node.status !== 'running') continue
				nodes.set(loopId, {
					status: 'failed',
					attempts: activeLoop.iteration + 1,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		for (const [nodeId, node] of nodes)
			if (node.status === 'pending' || node.status === 'running')
				nodes.set(nodeId, {
					...node,
					status: cancelled ? 'cancelled' : node.status,
				})
		const result = snapshot(
			id,
			cancelled ? 'cancelled' : 'failed',
			nodes,
			undefined,
			cancelled
				? undefined
				: error instanceof Error
					? error.message
					: String(error),
			trigger,
		)
		await update(result)
		if (cancelled) {
			for (const [nodeId, node] of nodes) {
				if (node.status !== 'cancelled') continue
				const step = byId.get(nodeId)
				if (!step || step.internal) continue
				const nodeContext = {
					...context,
					flowId: plan.id,
					nodeId,
					runId: id,
					signal,
				}
				const event = {
					runId: id,
					flowId: plan.id,
					input,
					ctx: context,
					nodeId,
					nodeInput: resolve(step.input, outputs),
					nodeCtx: nodeContext,
					node,
				}
				await hooks?.onNodeCancel?.(event)
				await hooks?.onNodeFinish?.(event)
			}
		} else await hooks?.onRunFail?.(result, error)
		return result
	}
}
