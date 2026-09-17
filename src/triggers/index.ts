import { triggerBrand } from '../internal'
import type { Trigger, TriggerDefinition } from '../types'

export type {
	AnyTrigger,
	Trigger,
	TriggerContext,
	TriggerDefinition,
	TriggerManager,
	TriggerOccurrence,
	TriggerRegistration,
	TriggerSetupContext,
} from '../types'

/** Creates a typed trigger that can be attached to a Better Flows workflow. */
export function defineTrigger<TType extends string, TPayload, TFlowInput>(
	definition: TriggerDefinition<TType, TPayload, TFlowInput>,
): Trigger<TType, TPayload, TFlowInput> {
	return { ...definition, [triggerBrand]: true }
}
