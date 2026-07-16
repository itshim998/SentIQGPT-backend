# Model-native tool verification

The release command is:

```powershell
npm run verify:model-native-tools
```

This is the default safe mode. It makes no intentional live provider calls and does not mutate `.env`, Azure, Supabase, or deployment state. A passing run proves the repository-local configuration, provider payload fixtures, Node/Python capability parity, recovery and completion-claim rules, executor integrations, frontend lifecycle reducer, compilation and syntax gates, focused regression suites, golden evaluation, and diff whitespace checks.

Live verification is explicitly opt-in:

```powershell
npm run verify:model-native-tools -- --live
```

Live mode runs only after every offline row passes. Its child processes receive the nine canonical flags as temporary environment values. It first starts isolated Node and FastAPI processes on loopback-only ports, validates internal capability details and the status-only public readiness contract, then shuts them down. The provider matrix is capped at five positive selection prompts and three ordinary-text negative prompts, with no automatic credential rotation in the live selection harness. Groq exercises streaming GPT-OSS local function calling; Gemini exercises buffered `google-genai` function calling. The executor matrix performs one logical Tavily retrieval, one bounded image-provider path, one deterministic chart render, one disposable in-memory private-file storage flow, and one disposable idempotent memory write and retrieval.

The canonical flags are:

- `SENTIQ_MODEL_TOOL_REGISTRY_ENABLED`
- `SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED`
- `SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED`
- `SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED`
- `SENTIQ_MODEL_IMAGE_SELECTION_ENABLED`
- `SENTIQ_MODEL_CHART_SELECTION_ENABLED`
- `SENTIQ_MODEL_FILE_SELECTION_ENABLED`
- `SENTIQ_MODEL_MEMORY_SELECTION_ENABLED`
- `SENTIQ_MODEL_TOOL_DIAGNOSTICS_ENABLED`

The command does not start Deep Research, write real personal memory, apply the automatic-memory migration, alter Azure, or deploy. Provider failures are reported as sanitized classes and matrix outcomes. The final live prerequisite row calls only the stable schema-version RPC on data shards 2-4. READY still requires that row to confirm version `20260715120000` before memory selection is enabled.
