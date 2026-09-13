import type { NodeContext } from './node'
import type { NodeRun, RunSnapshot } from './runtime'

/** A callback result ignored by the lifecycle dispatcher. */
export type HookResult = unknown | Promise<unknown>

/** Shared metadata for every workflow lifecycle event. */
export interface RunHookEvent<TContext extends object = object> {
	/** Unique identifier of this execution. */
	readonly runId: string
	/** Identifier of the flow being executed. */
	readonly flowId: string
	/** Original input supplied when the run was started. */
	readonly input: unknown
	/** Context created for this execution. */
	readonly ctx: TContext
}

/** Event emitted immediately before the workflow plan starts executing. */
export type RunStartEvent<TContext extends object = object> =
	RunHookEvent<TContext>

/** Event emitted when a workflow reaches a terminal state. */
export interface RunFinishEvent<TContext extends object = object>
	extends RunHookEvent<TContext> {
	/** Terminal snapshot recorded by the configured runtime. */
	readonly run: RunSnapshot
}

/** Event emitted when a workflow completes successfully. */
export type RunCompleteEvent<TContext extends object = object> =
	RunFinishEvent<TContext>

/** Event emitted when a workflow fails. */
export interface RunFailEvent<TContext extends object = object>
	extends RunFinishEvent<TContext> {
	/** Original error that caused the run to fail. */
	readonly error: unknown
}

/** Event emitted when a workflow is cancelled. */
export type RunCancelEvent<TContext extends object = object> =
	RunFinishEvent<TContext>

/** Shared metadata for node lifecycle events. */
export interface NodeHookEvent<TContext extends object = object>
	extends RunHookEvent<TContext> {
	/** Identifier of the declared node invocation. */
	readonly nodeId: string
	/** Input resolved for this node invocation. */
	readonly nodeInput: unknown
	/** Context supplied to the node implementation. */
	readonly nodeCtx: NodeContext<TContext>
}

/** Metadata for a single node attempt. */
export interface NodeAttemptEvent<TContext extends object = object>
	extends NodeHookEvent<TContext> {
	/** One-based number of the current attempt. */
	readonly attempt: number
	/** Maximum attempts allowed by the node retry policy. */
	readonly maxAttempts: number
}

/** Event emitted immediately before a node attempt begins. */
export type NodeStartEvent<TContext extends object = object> =
	NodeAttemptEvent<TContext>

/** Event emitted after a node attempt throws or fails validation. */
export interface NodeErrorEvent<TContext extends object = object>
	extends NodeAttemptEvent<TContext> {
	/** Original error from the failed attempt. */
	readonly error: unknown
	/** Whether another attempt will be scheduled. */
	readonly willRetry: boolean
}

/** Event emitted immediately before a retry delay begins. */
export interface NodeRetryEvent<TContext extends object = object>
	extends NodeErrorEvent<TContext> {
	/** Delay before the next attempt, in milliseconds. */
	readonly delay: number
}

/** Shared metadata for terminal node outcomes. */
export interface NodeFinishEvent<TContext extends object = object>
	extends NodeHookEvent<TContext> {
	/** Terminal execution state recorded for this node. */
	readonly node: NodeRun
}

/** Event emitted when a node completes successfully. */
export interface NodeCompleteEvent<TContext extends object = object>
	extends NodeFinishEvent<TContext> {
	/** Validated value produced by the node. */
	readonly output: unknown
}

/** Event emitted when a node exhausts its attempts and fails. */
export interface NodeFailEvent<TContext extends object = object>
	extends NodeFinishEvent<TContext> {
	/** Original error from the final failed attempt. */
	readonly error: unknown
}

/** Event emitted when a conditional path excludes a node. */
export type NodeSkipEvent<TContext extends object = object> =
	NodeFinishEvent<TContext>

/** Event emitted when a pending or running node is cancelled. */
export type NodeCancelEvent<TContext extends object = object> =
	NodeFinishEvent<TContext>

/** Names of lifecycle hooks that can fail and be reported. */
export type HookName = Exclude<keyof Hooks, 'onHookError'>

/** Event emitted when a lifecycle hook throws without affecting the workflow. */
export interface HookErrorEvent {
	/** Name of the hook callback that threw. */
	readonly hook: HookName
	/** Original error thrown by the hook callback. */
	readonly error: unknown
	/** Event originally supplied to the failed callback. */
	readonly event: unknown
}

/** Native workflow and node lifecycle callbacks. */
export interface Hooks<TContext extends object = object> {
	/** Runs once after run context is created and before the plan executes. */
	readonly onRunStart?: (event: RunStartEvent<TContext>) => HookResult
	/** Runs once when a workflow completes successfully. */
	readonly onRunComplete?: (event: RunCompleteEvent<TContext>) => HookResult
	/** Runs once when a workflow reaches a failed terminal state. */
	readonly onRunFail?: (event: RunFailEvent<TContext>) => HookResult
	/** Runs once when a workflow reaches a cancelled terminal state. */
	readonly onRunCancel?: (event: RunCancelEvent<TContext>) => HookResult
	/** Runs once after every terminal workflow outcome. */
	readonly onRunFinish?: (event: RunFinishEvent<TContext>) => HookResult
	/** Runs before every node attempt, including retries. */
	readonly onNodeStart?: (event: NodeStartEvent<TContext>) => HookResult
	/** Runs when a node completes with validated output. */
	readonly onNodeComplete?: (event: NodeCompleteEvent<TContext>) => HookResult
	/** Runs after each failed node attempt, including attempts that retry. */
	readonly onNodeError?: (event: NodeErrorEvent<TContext>) => HookResult
	/** Runs before the delay preceding a retried node attempt. */
	readonly onNodeRetry?: (event: NodeRetryEvent<TContext>) => HookResult
	/** Runs once when a node exhausts its attempts and fails. */
	readonly onNodeFail?: (event: NodeFailEvent<TContext>) => HookResult
	/** Runs once when a conditional path excludes a node. */
	readonly onNodeSkip?: (event: NodeSkipEvent<TContext>) => HookResult
	/** Runs once when a pending or running node is cancelled. */
	readonly onNodeCancel?: (event: NodeCancelEvent<TContext>) => HookResult
	/** Runs once after every terminal node outcome. */
	readonly onNodeFinish?: (event: NodeFinishEvent<TContext>) => HookResult
	/** Reports a lifecycle hook failure without affecting the workflow. */
	readonly onHookError?: (event: HookErrorEvent) => HookResult
}
