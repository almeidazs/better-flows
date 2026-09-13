import {
	createReference,
	dependencies,
	duration,
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
): RunSnapshot {
	return {
		id,
		status,
		...(output === undefined ? {} : { output }),
		...(error ? { error } : {}),
		nodes: Object.fromEntries(nodes),
	}
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
	step: Step,
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
	onNodeStart?: (context: Record<string, unknown>) => Promise<void> | void,
): Promise<RunSnapshot> {
	const nodes = new Map<string, NodeRun>(
		plan.steps.map((step) => [step.id, { status: 'pending', attempts: 0 }]),
	)
	const outputs = new Map<string, unknown>()
	const remaining = new Set(plan.steps.map((step) => step.id))
	const byId = new Map(plan.steps.map((step) => [step.id, step]))
	const remainingMaps = new Map(plan.maps.map((map) => [map.id, map]))
	const publish = async (status: RunSnapshot['status'] = 'running') =>
		update(snapshot(id, status, nodes))
	await publish()

	try {
		outputs.set('$input', await validate(plan.input, input))
		while (remaining.size > 0 || remainingMaps.size > 0) {
			if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError')
			for (const [mapId, map] of remainingMaps) {
				if (
					![...dependencies(map.items)].every(
						(dependency) =>
							dependency === '$input' ||
							nodes.get(dependency)?.status === 'completed',
					)
				)
					continue
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
			const ready = [...remaining]
				.map((stepId) => byId.get(stepId))
				.filter((step): step is Step => Boolean(step))
				.filter((step) =>
					[
						...new Set([
							...dependencies(step.input),
							...step.conditions.flatMap((condition) => [
								...dependencies(condition.value),
							]),
						]),
					].every(
						(dependency) =>
							dependency === '$input' ||
							nodes.get(dependency)?.status === 'completed',
					),
				)
			const mapSlots = new Map<string, number>()
			const limitedReady = ready.filter((step) => {
				if (!step.map?.concurrency) return true
				const count = mapSlots.get(step.map.id) ?? 0
				if (count >= step.map.concurrency) return false
				mapSlots.set(step.map.id, count + 1)
				return true
			})
			if (limitedReady.length === 0)
				throw new Error('Flow graph has unresolved or circular dependencies.')
			const completed = await Promise.allSettled(
				limitedReady.map(async (step) => {
					remaining.delete(step.id)
					if (!isSelected(step, outputs)) {
						nodes.set(step.id, { status: 'skipped', attempts: 0 })
						return
					}
					const retry = retryPolicy(step)
					let lastError: unknown
					for (let attempt = 1; attempt <= retry.attempts; attempt++) {
						if (signal.aborted)
							throw new DOMException('Run cancelled', 'AbortError')
						nodes.set(step.id, { status: 'running', attempts: attempt })
						await publish()
						const controller = new AbortController()
						signal.addEventListener('abort', () => controller.abort(), {
							once: true,
						})
						if (signal.aborted) controller.abort()
						try {
							const nodeContext = {
								...context,
								flowId: plan.id,
								nodeId: step.id,
								runId: id,
								signal: controller.signal,
							}
							await onNodeStart?.(nodeContext)
							const run = Promise.resolve(
								step.node.run({
									input: await validate(
										step.node.input,
										resolve(step.input, outputs),
									),
									ctx: nodeContext,
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
							return
						} catch (error) {
							lastError = error
							if (signal.aborted) throw error
							if (controller.signal.aborted) break
							if (attempt < retry.attempts)
								await sleep(
									(retry.backoff === 'exponential' ? 2 ** (attempt - 1) : 1) *
										1_000,
									signal,
								)
						}
					}
					nodes.set(step.id, {
						status: 'failed',
						attempts: retry.attempts,
						error:
							lastError instanceof Error
								? lastError.message
								: String(lastError),
					})
					throw lastError
				}),
			)
			const failure = completed.find(
				(result): result is PromiseRejectedResult =>
					result.status === 'rejected',
			)
			if (failure) throw failure.reason
			await publish()
		}
		const output = await validate(plan.output, resolve(plan.result, outputs))
		const result = snapshot(id, 'completed', nodes, output)
		await update(result)
		return result
	} catch (error) {
		const cancelled =
			signal.aborted ||
			(error instanceof DOMException && error.name === 'AbortError')
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
		)
		await update(result)
		return result
	}
}
