import type { RunHandle } from '../flows'
import type { triggerBrand } from '../internal'

/** Describes why and when a flow execution was started by a trigger. */
export interface TriggerOccurrence<TPayload = unknown> {
	readonly id: string
	readonly trigger: { readonly id: string; readonly type: string }
	readonly flow: { readonly id: string }
	readonly payload: TPayload
	readonly occurredAt: Date
	readonly metadata: Record<string, unknown>
}

/** Context supplied to a trigger input mapper. */
export type TriggerContext<TPayload = unknown> = TriggerOccurrence<TPayload>

/** Runtime services supplied while a trigger is attached to one flow. */
export interface TriggerSetupContext<TPayload = unknown, TFlowInput = unknown> {
	readonly flow: { readonly id: string }
	readonly trigger: { readonly id: string; readonly type: string }
	/** Creates an occurrence, maps it to flow input, and starts the flow. */
	emit(
		payload: TPayload,
		options?: {
			readonly occurredAt?: Date
			readonly metadata?: Record<string, unknown>
		},
	): Promise<RunHandle<TFlowInput>>
}

/** Definition used to create a typed, reusable flow trigger. */
export interface TriggerDefinition<TType extends string, TPayload, TFlowInput> {
	/** Discriminator used to identify the trigger implementation. */
	readonly type: TType
	/** Optional stable identifier within the target flow. */
	readonly id?: string
	/** Maps one trigger occurrence into the input accepted by its target flow. */
	readonly input: (
		context: TriggerContext<TPayload>,
	) => TFlowInput | Promise<TFlowInput>
	/** Installs the trigger after its target flow has been registered. */
	readonly setup?: (
		context: TriggerSetupContext<TPayload, TFlowInput>,
	) => void | Promise<void>
	/** Releases resources created by setup. */
	readonly dispose?: () => void | Promise<void>
}

/** A branded trigger created by {@link defineTrigger}. */
export type Trigger<
	TType extends string = string,
	TPayload = unknown,
	TFlowInput = unknown,
> = TriggerDefinition<TType, TPayload, TFlowInput> & {
	readonly [triggerBrand]: true
}

/** Broad trigger constraint used by trigger registries. */
export type AnyTrigger = {
	readonly type: string
	readonly id?: string
	readonly input: (...arguments_: never[]) => unknown
	readonly setup?: (...arguments_: never[]) => unknown
	readonly dispose?: () => void | Promise<void>
	readonly [triggerBrand]: true
}

/** Associates a trigger with a flow identifier in `betterFlows({ triggers })`. */
export interface TriggerRegistration {
	readonly flow: string
	readonly trigger: AnyTrigger
}

/** Controls triggers registered on one Better Flows instance. */
export interface TriggerManager {
	/** Validates and installs every configured trigger. */
	start(): Promise<void>
	/** Disposes every installed trigger. */
	stop(): Promise<void>
}
