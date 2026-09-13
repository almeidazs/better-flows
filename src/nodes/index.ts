import { nodeBrand, type RuntimeNode } from '../internal'
import type { Node, NodeDefinition } from '../types'

export type {
	AnyNode,
	Node,
	NodeContext,
	NodeDefinition,
	NodeInput,
	NodeOutput,
} from '../types'

export type { RuntimeNode }

/**
 * Creates a typed, reusable unit of workflow execution.
 *
 * Input and output types are inferred from the `run` function or Standard
 * Schema validators, allowing downstream nodes to receive typed references.
 */
export function defineNode<TInput, TOutput, TContext extends object = object>(
	definition: NodeDefinition<TInput, TOutput, TContext>,
): Node<TInput, TOutput, TContext> {
	return { ...definition, [nodeBrand]: true }
}
