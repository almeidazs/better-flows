import {
	dependencies,
	duration,
	type Plan,
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

function isSelected(
	step: Step,
	outputs: ReadonlyMap<string, unknown>,
): boolean {
	return step.conditions.every(({ value, expected, otherwise }) =>
		otherwise
			? !otherwise.includes(resolve(value, outputs) as PropertyKey)
			: resolve(value, outputs) === expected,
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
	const publish = async (status: RunSnapshot['status'] = 'running') =>
		update(snapshot(id, status, nodes))
	await publish()

	try {
		outputs.set('$input', await validate(plan.input, input))
		while (remaining.size > 0) {
			if (signal.aborted) throw new DOMException('Run cancelled', 'AbortError')
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
			if (ready.length === 0)
				throw new Error('Flow graph has unresolved or circular dependencies.')
			const completed = await Promise.allSettled(
				ready.map(async (step) => {
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
