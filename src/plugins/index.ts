import type { NodeContext } from '../nodes'
import type { RunSnapshot } from '../runtimes'

/** Extends Better Flows with lifecycle hooks, per-run context, and a public API. */
export interface Plugin<
	TName extends string = string,
	TApi extends object = object,
	TContext extends object = object,
> {
	readonly name: TName
	/** Produces plugin-specific context for each execution. */
	readonly context?: (
		context: Record<string, unknown>,
	) => TContext | Promise<TContext>
	/** Creates the API exposed at `flows.plugins[name]`. */
	readonly create?: () => TApi
	/** Runs once immediately before a workflow execution starts. */
	readonly onRunStart?: (run: {
		readonly id: string
		readonly flowId: string
	}) => void | Promise<void>
	/** Runs once after a workflow execution reaches a terminal state. */
	readonly onRunFinish?: (run: RunSnapshot) => void | Promise<void>
	/** Runs immediately before every node attempt. */
	readonly onNodeStart?: (node: NodeContext) => void | Promise<void>
}

/** Creates a plugin with lifecycle hooks, context, and an optional public API. */
export function definePlugin<
	TName extends string,
	TApi extends object = object,
	TContext extends object = object,
>(plugin: Plugin<TName, TApi, TContext>): Plugin<TName, TApi, TContext> {
	return plugin
}

/** Maps configured plugin names to their public APIs. */
export type PluginApi<TPlugins extends readonly Plugin[]> = {
	readonly [TPlugin in TPlugins[number] as TPlugin['name']]: TPlugin extends Plugin<
		string,
		infer TApi,
		object
	>
		? TApi
		: never
}
