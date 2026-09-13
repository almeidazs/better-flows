import {
	compileFlow,
	type Flow,
	type FlowDefinition,
	type RunHandle,
} from './flows'
import type { AnyNode } from './nodes'
import type { PluginApi, PluginDefinition } from './plugins'
import type { RunSnapshot, Runtime, WorkerRuntime } from './runtimes'
import { executePlan } from './runtimes/engine'
import type { HookName, HookResult, Hooks } from './types'
import type { EngineHooks } from './types/internal'

function createHookDispatcher(hooks: readonly Hooks[]) {
	const report = async (hook: HookName, event: unknown, error: unknown) => {
		for (const configured of hooks) {
			try {
				await configured.onHookError?.({ hook, event, error })
			} catch {}
		}
	}
	return {
		async dispatch(hook: HookName, event: unknown) {
			for (const configured of hooks) {
				const callback = configured[hook] as
					| ((value: unknown) => HookResult)
					| undefined
				if (!callback) continue
				try {
					await callback(event)
				} catch (error) {
					await report(hook, event, error)
				}
			}
		},
	}
}

/** Configuration used to create a Better Flows instance. */
export interface BetterFlowsOptions<
	TNodes extends Record<string, AnyNode>,
	TContext extends object,
	TPlugins extends readonly PluginDefinition[],
> {
	readonly runtime: Runtime
	/** Registry of nodes available to flows defined on this instance. */
	readonly nodes: TNodes
	/** Native lifecycle callbacks for every workflow execution. */
	readonly hooks?: Hooks<TContext>
	/** Produces application context for each execution. */
	readonly context?: (arguments_: {
		readonly flowId: string
		readonly input: unknown
		readonly runId: string
	}) => TContext | Promise<TContext>
	/** Optional extensions that provide context, hooks, or a public API. */
	readonly plugins?: TPlugins
}

/** Runtime-bound API for defining, running, and inspecting workflows. */
export interface BetterFlows<
	TNodes extends Record<string, AnyNode>,
	TPlugins extends readonly PluginDefinition[],
> {
	/** Compiles and registers a named workflow on this instance. */
	defineFlow<TInput, TOutput>(
		definition: FlowDefinition<TInput, TOutput>,
	): Flow<TInput, TOutput>
	/** Starts a registered flow with typed input. */
	run<TInput, TOutput>(
		flow: Flow<TInput, TOutput>,
		input: TInput,
	): Promise<RunHandle<TOutput>>
	/** Queries snapshots by run ID. */
	readonly runs: {
		/** Returns the latest snapshot for a run, including typed node outputs. */ get(
			id: string,
		): Promise<RunSnapshot<TNodes>>
	}
	/** Registered nodes. */
	readonly nodes: TNodes
	/** APIs exposed by configured plugins, keyed by plugin name. */
	readonly plugins: PluginApi<TPlugins>
	/** Starts a worker when the configured runtime supports workers. */
	worker(): { close(): Promise<void> }
}

/**
 * Creates a Better Flows instance bound to one runtime, node registry, and
 * optional plugins. Use the returned instance to define flows and start runs.
 */
export function betterFlows<
	TNodes extends Record<string, AnyNode>,
	TContext extends object = object,
	const TPlugins extends
		readonly PluginDefinition[] = readonly PluginDefinition[],
>(
	options: BetterFlowsOptions<TNodes, TContext, TPlugins>,
): BetterFlows<TNodes, TPlugins> {
	const plugins = options.plugins ?? ([] as unknown as TPlugins)
	const hookDispatcher = createHookDispatcher([
		...(options.hooks ? [options.hooks as Hooks] : []),
		...plugins.flatMap((plugin) =>
			plugin.hooks ? [plugin.hooks as Hooks] : [],
		),
	])

	const names = new Set<string>()

	for (const plugin of plugins) {
		if (names.has(plugin.name))
			throw new Error(`Plugin "${plugin.name}" is configured more than once.`)

		names.add(plugin.name)
	}

	const pluginApi = Object.fromEntries(
		plugins.map((plugin) => [plugin.name, plugin.create?.() ?? {}]),
	) as PluginApi<TPlugins>

	const flows = new Map<string, Flow<unknown, unknown>>()

	const executionFor = <TInput, TOutput>(
		flow: Flow<TInput, TOutput>,
		input: TInput,
		id: string,
	) => {
		return {
			id,
			plan: flow.plan,
			input,
			context: {},
			execute: async (
				update: (snapshot: RunSnapshot) => Promise<void> | void,
				signal: AbortSignal,
			) => {
				let context: Record<string, unknown>
				try {
					context = {
						...(options.context
							? await options.context({ flowId: flow.id, input, runId: id })
							: {}),
						...Object.fromEntries(
							await Promise.all(
								plugins.map(
									async (plugin) =>
										[
											plugin.name,
											plugin.context ? await plugin.context({}) : {},
										] as const,
								),
							),
						),
					}
				} catch (error) {
					context = {}
					const result: RunSnapshot = {
						id,
						status: 'failed',
						error: error instanceof Error ? error.message : String(error),
						nodes: Object.fromEntries(
							flow.plan.steps.map((step) => [
								step.id,
								{ status: 'pending', attempts: 0 },
							]),
						),
					}
					await update(result)
					const event = {
						runId: id,
						flowId: flow.id,
						input,
						ctx: context,
						run: result,
					}
					await hookDispatcher.dispatch('onRunFail', { ...event, error })
					await hookDispatcher.dispatch('onRunFinish', event)
					return result
				}
				await hookDispatcher.dispatch('onRunStart', {
					runId: id,
					flowId: flow.id,
					input,
					ctx: context,
				})
				let runError: unknown
				const nodeHooks: EngineHooks = {
					onNodeStart: (event) => hookDispatcher.dispatch('onNodeStart', event),
					onNodeComplete: (event) =>
						hookDispatcher.dispatch('onNodeComplete', event),
					onNodeError: (event) => hookDispatcher.dispatch('onNodeError', event),
					onNodeRetry: (event) => hookDispatcher.dispatch('onNodeRetry', event),
					onNodeFail: (event) => hookDispatcher.dispatch('onNodeFail', event),
					onNodeSkip: (event) => hookDispatcher.dispatch('onNodeSkip', event),
					onNodeCancel: (event) =>
						hookDispatcher.dispatch('onNodeCancel', event),
					onNodeFinish: (event) =>
						hookDispatcher.dispatch('onNodeFinish', event),
					onRunFail: (_, error) => {
						runError = error
					},
				}
				const result = await executePlan(
					id,
					flow.plan,
					input,
					context,
					update,
					signal,
					nodeHooks,
				)
				const event = {
					runId: id,
					flowId: flow.id,
					input,
					ctx: context,
					run: result,
				}
				if (result.status === 'completed')
					await hookDispatcher.dispatch('onRunComplete', event)
				else if (result.status === 'cancelled')
					await hookDispatcher.dispatch('onRunCancel', event)
				else
					await hookDispatcher.dispatch('onRunFail', {
						...event,
						error: runError ?? new Error(result.error),
					})
				await hookDispatcher.dispatch('onRunFinish', event)
				return result
			},
		}
	}

	const start = async <TInput, TOutput>(
		flow: Flow<TInput, TOutput>,
		input: TInput,
	): Promise<RunHandle<TOutput>> => {
		const execution = executionFor(flow, input, crypto.randomUUID())
		const runId = await options.runtime.start(execution)
		const handle: RunHandle<TOutput> = {
			id: runId,
			status: 'running',
			nodes: {},
			async wait() {
				const result = await options.runtime.wait(runId)
				handle.status = result.status
				handle.nodes = result.nodes
				if (result.output !== undefined)
					handle.output = result.output as TOutput
				return result as RunSnapshot & { output?: TOutput }
			},
			async cancel() {
				await options.runtime.cancel(runId)
				handle.status = 'cancelled'
			},
		}
		return handle
	}

	return {
		defineFlow<TInput, TOutput>(
			definition: FlowDefinition<TInput, TOutput>,
		): Flow<TInput, TOutput> {
			if (flows.has(definition.id))
				throw new Error(`Flow "${definition.id}" is already registered.`)
			const compiled = compileFlow(definition)
			const flow = {
				...compiled,
				run: (input: unknown) => start(flow as Flow<unknown, unknown>, input),
			} as Flow<unknown, unknown>
			flows.set(definition.id, flow)
			return flow as Flow<TInput, TOutput>
		},
		run: start,
		runs: {
			async get(id: string) {
				const result = await options.runtime.get(id)

				if (!result) throw new Error(`Run "${id}" was not found.`)

				return result as RunSnapshot<TNodes>
			},
		},
		nodes: options.nodes,
		plugins: pluginApi,
		worker() {
			if (!('worker' in options.runtime))
				throw new Error('The configured runtime does not provide workers.')

			return (options.runtime as WorkerRuntime).worker(
				async (flowId, input, runId, update, signal) => {
					const flow = flows.get(flowId)
					if (!flow)
						throw new Error(
							`Flow "${flowId}" is not registered in this worker process.`,
						)
					const execution = executionFor(flow, input, runId)
					return execution.execute(update, signal)
				},
			)
		},
	}
}
