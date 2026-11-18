# Context-aware Native read deduplication

中文：[上下文读取去重](上下文读取去重.md).

A repeated Native text read can replace its numbered body with an unchanged reference only after OPS proves that the exact successful earlier body was included in the latest completed ordinary model request. The result retains its path, line range, revision, completeness and continuation notices, and identifies the earlier tool call and durable message. Its count says that rows were revalidated, not displayed again.

Every invocation still performs the normal authorized worker read. This saves repeated model-output/context bytes; it is not an IO cache or an IO-speed claim. PTC canonical values and nested transport content remain complete. First reads, short reads for which a reference would be longer, hex output, clipped output and uncertain evidence use normal output.

## Evidence and invalidation

All of these facts must agree:

- A successful owned top-level read, correlated through the registry's opaque execution token and final tools/result.
- The committed tool/result message identity, source call identity and exact text. User messages or arguments containing identical words are insufficient.
- The same message and body in the latest successfully completed ordinary llm/stream request, preceded by its matching assistant tool call and arguments.
- The same live session object, surface.contentGeneration, path, file identity, size, nanosecond modification/change times, revision, requested arguments/range and freshly rendered body.

An ordinary request clears previous proof before starting. Failed, aborted, incomplete or superseded requests cannot restore it. Auxiliary compaction/title calls never supply evidence. An older concurrent completion cannot override a newer request. Both surface replacement and message-content projection invalidate records. An unchanged file or a body retained only in the transcript is never enough.

Permission-mode changes, agent/session disposal, component unload, and mutation or unknown tool results discard evidence. Missing signals silently disable optimization. Evidence belongs to the mounting component and calling agent. Retention is bounded to 16 agents, 32 records and 2 MiB of bodies per agent; evictions return full output. There is no disk cache, host registry replacement or new dependency.

This supports ops_inspect_local_file and ops_read_files. A repeated batch must match the complete earlier batch message and arguments. Every returned file is independently revalidated; a changed, missing, clipped or unobserved sibling keeps the entire body. Pending files, failed items and storage references are never eligible. Bounded line ranges may remain incomplete at file level: their original completeness and continuation notices are retained.

## Pinned host research

Research inspected these primary sources in the installed, lockfile-pinned 0.2.0-rc.2 npm packages:

| Source | Contract |
| --- | --- |
| @deepseek-ai/dsh-llm/lib/types/types.d.ts: GenerateOptions | messages is the ordered provider-visible request; auxiliary calls carry purpose. |
| @deepseek-ai/dsh-llm/lib/types/index.d.ts: llm/stream; lib/index.js: adapter dispatch | The public waterfall surrounds adapter dispatch; text tool bodies preserve content and message identities. |
| @deepseek-ai/dsh-llm/lib/types/message.d.ts | Tool messages carry stable message ID, role, source and call ID; assistant tool-call blocks retain raw arguments. |
| @deepseek-ai/dsh-session/lib/types/surface.d.ts; lib/index.js: applySurfacePlan | contentGeneration changes for replacement and message projection; ordinary tail appends do not change it. |
| @deepseek-ai/dsh-tools/lib/types/index.d.ts: ToolDefinition, ToolExecution, tools/result | Finalization changes only content; the registry owns other fields and the token; final results are frozen; nested dispatches carry parent. |

Tests use real Cordis tools, LLM runtime with a recording adapter, SessionStore, Native worker and host sandbox/subprocess services. They exercise the actual session replacement mechanism used by compaction and actual message-projection registration, not an external compactor's summarization quality. Coverage includes reduction and canonical-value preservation, current authority, changed/forged identities, auxiliary/latest/concurrent requests, metadata/range changes, nested transport, policy content, compaction/projection, disposal and bounded retention.

Run npm run build:ptc, npm run build, then node test/run.mjs context-read. A missing worker is a skip, never a pass.
