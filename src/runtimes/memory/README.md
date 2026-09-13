# Memory runtime

`memory()` runs workflows in the current process and retains snapshots only in
memory. It is the default choice for unit tests and local development.

```ts
import { betterFlows } from 'better-flows'
import { memory } from 'better-flows/memory'

const flows = betterFlows({ runtime: memory(), nodes: {} })
```

Runs start immediately. Use `flows.runs.get(id)` to inspect the latest snapshot
and `run.wait()` to await its terminal result. State is not shared between
processes and disappears when the process exits.
