# Model-native request cost model

These are primary logical answer-model call counts for the successful request path with WebSurf V2 enabled. They do not include safety-model checks, provider attempts, embeddings, optional continuation, or background work.

| Request shape | Primary answer-model calls | Tool calls |
| --- | ---: | ---: |
| Ordinary Fast chat | 1 | 0 |
| Ordinary Intuitive chat | 1 | 0 |
| Automatic WebSurf | 2 (selection + bounded synthesis) | 1 |
| Automatic image generation | 1 | 1 |
| Automatic chart generation | 1 | 1 |
| Automatic file generation | 2 (selection + artifact content) | 1 |
| Automatic memory update | 1 | 1 |
| Manual WebSurf | 1 bounded synthesis | 1 |
| Manual image generation | 0 | 1 |
| Ambiguous request requiring clarification | 1 | 0 |

The clarification row is an ordinary assistant text response. The user's answer starts a new ordinary turn. Terminal tools do not trigger a post-tool text continuation. Automatic memory writes do not run the legacy memory classifier or summarizer. Automatic WebSurf disables SentIQ tools during its single synthesis continuation.

When `SENTIQ_WEBSURF_V2_ENABLED` is false, the legacy retrieval branch asks Tavily for its generated answer and sets `skipLLMSynthesis: true`. In that configuration, automatic WebSurf is one answer-model selection call plus one retrieval tool call, while manual WebSurf has no answer-model call.

## Additional and optional provider cost

- Every Node-to-Python model request first calls the safety model for input classification. A streaming text response also receives a final output-safety call and can trigger periodic background output checks.
- A truncated ordinary non-WebSurf response can make one bounded continuation call.
- Intuitive context can make one conversation-compression call after its message threshold, one semantic-query embedding call, and bounded embedding-backfill calls. Intuitive automatic memory storage can also block on one embedding call.
- File generation makes one artifact-model call on the happy path and can make one additional artifact-model call after primary generation, parsing, rendering, or validation failure.
- Provider key rotation and pre-output fallback can create multiple provider attempts inside one logical answer-model call. A WebSurf synthesis fallback is therefore not necessarily one provider invocation.
- Eligible new conversations can schedule one title-generation call. Conversation-capsule refresh can schedule one summary call, and a threshold-crossing workspace refresh can add another.

These paths must be measured separately from the primary user-turn decision cost. Reflection is not part of the current request path.

## Controlled enablement

Repository defaults remain off. A controlled environment must set `SENTIQ_MODEL_TOOL_REGISTRY_ENABLED=true`, enable the transport for every serving provider (`SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED=true` and, when Gemini fallback must retain tools, `SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED=true`), then enable only the approved product tools:

- `SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_IMAGE_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_CHART_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_FILE_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_MEMORY_SELECTION_ENABLED=true`

Turning the registry or a selection flag off leaves ordinary chat and explicit manual controls available. It does not reactivate any keyword router. Real `.env` values are a deployment decision and are not changed by this pass.
