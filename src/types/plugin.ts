import type { Hooks } from './hooks'

/** Context visible to hooks declared by one named plugin. */
export type PluginHookContext<
	TName extends string,
	TContext extends object,
> = Record<string, unknown> & { readonly [TKey in TName]: TContext }

/** Broad plugin shape used internally by the Better Flows plugin registry. */
export interface PluginDefinition {
	/** Unique plugin name. */
	readonly name: string
	/** Produces context stored under the plugin name for each execution. */
	readonly context?: (
		context: Record<string, unknown>,
	) => object | Promise<object>
	/** Lifecycle hooks with plugin-specific context types. */
	readonly hooks?: unknown
	/** Produces the API exposed on the Better Flows instance. */
	readonly create?: () => object
}

/** Extends Better Flows with run-scoped context, lifecycle hooks, and a public API. */
export interface Plugin<
	TName extends string = string,
	TApi extends object = object,
	TContext extends object = object,
> {
	/** Unique name used for this plugin's public API and context namespace. */
	readonly name: TName
	/** Produces plugin-specific context for each execution. */
	readonly context?: (
		context: Record<string, unknown>,
	) => TContext | Promise<TContext>
	/** Adds lifecycle hooks to every run configured on the Better Flows instance. */
	readonly hooks?: Hooks<PluginHookContext<TName, TContext>>
	/** Creates the API exposed at `flows.plugins[name]`. */
	readonly create?: () => TApi
}

/** Maps configured plugin names to their public APIs. */
export type PluginApi<TPlugins extends readonly PluginDefinition[]> = {
	readonly [TPlugin in TPlugins[number] as TPlugin['name']]: TPlugin extends Plugin<
		string,
		infer TApi,
		object
	>
		? TApi
		: never
}
