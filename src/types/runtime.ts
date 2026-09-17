import type { Plan } from './internal'
import type { AnyNode, NodeOutput } from './node'
import type { TriggerOccurrence } from './trigger'

/** The lifecycle state of a workflow run. */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** The lifecycle state of one node within a run. */
export type NodeStatus = RunStatus | 'pending' | 'skipped'

/** Recorded execution state for a node. */
export interface NodeRun<TOutput = unknown> {
	readonly status: NodeStatus
	readonly output?: TOutput
	readonly error?: string
	readonly attempts: number
}

/** Resolves an unknown output for broad node constraints. */
type RegisteredNodeOutput<TNode> = [NodeOutput<TNode>] extends [never]
	? unknown
	: NodeOutput<TNode>

/** Node states addressable through a Better Flows node registry. */
export type RunNodes<TNodes extends Record<string, AnyNode>> = Readonly<
	Record<string, NodeRun>
> & {
	readonly [TNodeName in keyof TNodes]: NodeRun<
		RegisteredNodeOutput<TNodes[TNodeName]>
	>
}

/** Serializable workflow run state returned by runtimes. */
export interface RunSnapshot<
	TNodes extends Record<string, AnyNode> = Record<string, AnyNode>,
> {
	readonly id: string
	readonly status: RunStatus
	readonly output?: unknown
	readonly error?: string
	/** Trigger occurrence that started this run, when applicable. */
	readonly trigger?: TriggerOccurrence
	/** Latest state for each node invocation in this run. */
	readonly nodes: RunNodes<TNodes>
}

/** Internal execution payload supplied to a runtime. */
export interface Execution {
	readonly id: string
	readonly plan: Plan
	readonly input: unknown
	readonly context: Record<string, unknown>
	readonly trigger?: TriggerOccurrence
	readonly execute: (
		update: (snapshot: RunSnapshot) => Promise<void> | void,
		signal: AbortSignal,
	) => Promise<RunSnapshot>
}

/** Storage and execution adapter for Better Flows. */
export interface Runtime {
	/** Creates and starts a workflow execution. */
	start(execution: Execution): Promise<string>
	/** Returns the latest snapshot for an execution, if it exists. */
	get(id: string): Promise<RunSnapshot | undefined>
	/** Waits until an execution reaches a terminal state. */
	wait(id: string): Promise<RunSnapshot>
	/** Requests cooperative cancellation of an execution. */
	cancel(id: string): Promise<void>
	/** Releases resources held by the runtime. */
	close?(): Promise<void>
}

/** Function invoked by a worker-capable runtime for each queued flow. */
export type FlowProcessor = (
	flowId: string,
	input: unknown,
	runId: string,
	update: (snapshot: RunSnapshot) => Promise<void> | void,
	signal: AbortSignal,
	trigger?: TriggerOccurrence,
) => Promise<RunSnapshot>

/** A runtime that can process queued executions in a worker. */
export interface WorkerRuntime extends Runtime {
	/** Starts a worker that invokes the processor for queued executions. */
	worker(processor: FlowProcessor): { close(): Promise<void> }
}
