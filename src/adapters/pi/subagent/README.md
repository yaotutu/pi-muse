# pi subagent adapter

Current project SDK runtime: `@earendil-works/pi-coding-agent@1.6.1`.
Subagent orchestration semantics and initial structure originally adapted from
`@earendil-works/pi-coding-agent` **1.3.0** upstream
[`examples/extensions/subagent`](https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent/examples/extensions/subagent).

The upstream example is MIT licensed (copyright Mario Zechner). The repository
retains its single / parallel / chain execution semantics, `{previous}` chain substitution,
8-task / 4-concurrent parallel limits, input-order results and 50 KiB per-result cap.

This is an adapted source integration, **not an unmodified upstream extension**:

- Tool parameters are unified into top-level required `mode` ("single" | "parallel" | "chain")
  and `tasks` array (1-8 items of `{ agent, task }`). Ambiguous legacy top-level `agent`/`task`/`chain`
  fields are removed. Single mode strictly requires exactly 1 task.
- `constrainedSampling` is declared with `{ type: "json_schema", strict: "prefer" }` to guide
  providers supporting strict JSON Schema.
- Child CLI spawning is replaced by the shared deny-by-default `runSubagent` kernel (`../subagent-runner.ts`), used across chat routing and background structured workers.
- All specialized subagents (`sms`, `news`, `browser`, `habits`, `dream`) are statically defined in `../subagents/catalog.ts` and registered in `src/features/subagents/registry.ts` (read-only inspectable via `GET /api/subagents`). Legacy coding roles (`scout`, `planner`, `reviewer`, `worker`) and `DATA_DIR/subagents` dynamic overrides are removed.
- Exclusive subagents (`parallelAllowed: false`, such as `browser`) are rejected in `parallel` mode before queuing or starting children.
- CLI/TUI rendering and raw child message/stderr details are omitted. Parent
  model receives the bounded final result; existing presentation rules control
  what is exposed to HTTP clients.
- Subagents are parent-owned tool executions, never independent queued jobs.
- Single task count mismatch and unknown roles are rejected before queuing or starting children
  with controlled safe rejection messages (`denied: true`). Cancellation drains child sessions without retries.

No installed SDK files are modified. Re-evaluate this adapter against the official
example when updating the pi dependency; do not silently restore CLI spawning.

## MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
