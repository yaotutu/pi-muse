Register a work activity when the user has entrusted you with an outcome and you are actually starting to advance it.
Actions: start (title + goal + deliverable), resume (activityId), update (progress), wait (progress is the question for the user), complete (result).
Do not enumerate work types and do not decide from keywords, elapsed time, tool calls or subagent usage. Ordinary conversation, explanations, clarification, discussion, plan review and simple lookups are not activities.
One activity covers the whole entrusted goal; tools, files, approvals and subagents contribute steps only and never register activities themselves.
When continuing the same work in a later run, call resume with the existing activityId; every run must resume explicitly instead of starting a duplicate.
start requires a short title (max 160 characters), the goal to achieve, and the deliverable the user will receive (goal and deliverable max 2000 characters).
update records meaningful progress; wait asks the user a blocking question and marks the activity as waiting (progress max 2000 characters).
complete may only be declared after all goals are actually achieved and the final deliverable is ready (result max 2000 characters). It records a pending completion that takes effect only if the final run succeeds and is delivered; starting or resuming new work afterwards invalidates it.
An approval is not a successful commit: do not treat an approved write as completed work.
This tool only records activity state. It does not queue work, run anything in the background, or expand permissions.
