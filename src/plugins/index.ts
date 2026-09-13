import type { Plugin } from '../types'

export type {
	Plugin,
	PluginApi,
	PluginDefinition,
	PluginHookContext,
} from '../types'

/** Creates a plugin with lifecycle hooks, context, and an optional public API. */
export function definePlugin<
	const TName extends string,
	TApi extends object = object,
	TContext extends object = object,
>(plugin: Plugin<TName, TApi, TContext>): Plugin<TName, TApi, TContext> {
	return plugin
}
