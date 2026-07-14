# Model-native request cost model

These are structural call counts for the normal request path. They do not require live provider billing.

| Request shape | Text-model calls | Tool calls |
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

The clarification row is an ordinary assistant text response. The user's answer starts a new ordinary turn. Terminal tools do not trigger a post-tool text continuation. Automatic memory writes store the validated tool payload directly, without a classifier or summarizer call. Automatic WebSurf disables tools during its single synthesis continuation.

## Controlled enablement

Repository defaults remain off. A controlled environment must set `SENTIQ_MODEL_TOOL_REGISTRY_ENABLED=true`, enable the transport for every serving provider (`SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED=true` and, when Gemini fallback must retain tools, `SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED=true`), then enable only the approved product tools:

- `SENTIQ_MODEL_WEBSURF_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_IMAGE_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_CHART_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_FILE_SELECTION_ENABLED=true`
- `SENTIQ_MODEL_MEMORY_SELECTION_ENABLED=true`

Turning the registry or a selection flag off leaves ordinary chat and explicit manual controls available. It does not reactivate any keyword router. Real `.env` values are a deployment decision and are not changed by this pass.
