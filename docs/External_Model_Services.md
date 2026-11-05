# External model services

**Status:** Implemented in Topsl's local proxy on 5 November 2026 and verified with synthetic local services only ([execution record](Native_Harness_Execution.md#retirement-of-the-direct-claude-plan-connection-and-external-model-services)). No live external service has been qualified.
**Owner of this contract:** Topsl's native harness ([plan §1.3](Native_Harness_Plan.md#13-follow-up--direct-claude-plan-retired-again-and-external-model-services)). The capability document below is the version 1 shape a separately developed service can publish.

An **external model service** is a separately operated service that Topsl's native harness reaches over a standard inference protocol. In the code it is the `openai-compatible` connection kind; only its presentation changed. Topsl owns projects, orchestration, tools, execution policy and history. The service owns its upstream integrations, accounts, terms and billing. Topsl receives the service's URL and, when the service needs one, the service's own access key. It never obtains, refreshes or holds an upstream provider credential for the service.

Running an integration in a separate service does not make it permitted. Whatever the service does upstream remains subject to that upstream's terms, and Topsl cannot see or verify it. In particular, Anthropic's [legal and compliance guidance](https://code.claude.com/docs/en/legal-and-compliance) separates a user signing in to the unmodified Claude Code program from third-party handling of Claude subscription credentials, and its [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) addresses authentication for third-party products separately. An external service is not a way around either.

## Connecting

The owner enters, when adding the connection:

| Setting | Values | Rules |
|---|---|---|
| Inference base URL | For example `https://service.example/v1` | `https`, or `http` only on `127.0.0.1`, `localhost` or `[::1]`. No user name or password in the URL, no query, no fragment. Redirects are never followed, so a key cannot be forwarded to another host. |
| Protocol | `chat` (Chat Completions), `responses` or `messages` (Anthropic Messages) | Only this protocol is dispatched. Topsl's canonical conversion carries streaming, tool-call IDs, argument assembly, tool results, cancellation and the service's error codes, and refuses a conversion it cannot make exactly. |
| Authentication | `bearer` (default), `x-api-key`, `none` | The key goes in `Authorization: Bearer …` or in `x-api-key`. `none` is accepted only for a loopback URL. The key is read from the clipboard by Topsl, stored in the proxy's encrypted database, and never enters the window, prompts, tools or logs. |

These three settings are fixed for the life of the connection. A different URL, protocol or authentication method is a new connection, with a new ID and new routes, so a task bound to the old one can never follow a change. Rotating the key of the same connection keeps its routes.

Then **List models** (or a typed model ID when the service has no catalog) and a route name. The default suggestion is `external/<model>`.

Funding is shown as **Managed by external service** (`funding: "gateway"` in stored records). Topsl records the token counts the service reports and shows nothing about price, allowance or reset times.

## Inference contract

Topsl appends these paths to the base URL exactly once:

| Operation | Path | Protocol |
|---|---|---|
| Model catalog | `GET /models` | OpenAI `data[]` or `models[]`, following `has_more`/`last_id` pagination; a repeated cursor is refused |
| Chat inference | `POST /chat/completions` | `chat` |
| Responses inference | `POST /responses` | `responses` |
| Messages inference | `POST /messages` | `messages` (Topsl adds `anthropic-version: 2023-06-01`) |

A service need not implement every protocol. Requests ask for a stream (`accept: text/event-stream`); a service that answers with one JSON body still works, but Topsl's connection test records streaming as unsupported. Failures keep their HTTP status, code and request ID. Topsl's proxy never retries a request, apart from one same-identity renewal for a ChatGPT plan, which does not apply here.

## Optional capability document

`GET <inference base>/gateway/capabilities`, normally `/v1/gateway/capabilities`, sent with the same authentication as inference. Version 1:

```json
{
  "schema_version": 1,
  "gateway_id": "gw_example",
  "revision": "cfg_7",
  "routes": [
    {
      "id": "route_review",
      "model": "reviewer",
      "route_revision": "route_review_3",
      "engine": "model-api",
      "protocols": [
        {
          "name": "messages",
          "capabilities": {
            "streaming": "supported",
            "tool_calls": "supported",
            "parallel_tool_calls": "unknown",
            "structured_output": "unsupported",
            "images": "unknown",
            "reasoning": "unknown"
          }
        }
      ],
      "extensions": { "route_revision_pinning": true }
    }
  ]
}
```

Topsl reads it only when the owner chooses **Read service capabilities**. It is not a model request. How Topsl treats each answer:

| Answer | Result |
|---|---|
| 200 with a valid version 1 document | Recorded. A Topsl route whose model and protocol match a listed route takes its declared capabilities and, when pinning is declared with a `route_revision`, its remote pin. |
| 404 or 501 | **Not published.** Capabilities stay unknown; inference is unaffected. |
| Not JSON, another `schema_version`, a shape that fails validation, or over 1 MB | **Not recognized.** Same as not published. |
| Network failure or another status | **Unavailable.** Same as not published. |
| 401 or 403 | Reported as an authentication or permission rejection. Topsl substitutes no other credential. |

Only a document that was read changes routes. A later outage, 404 or unrecognized document leaves every route's pin and evidence as they were, so a task bound to a pinned route never silently loses its pin. A route whose `engine` is not `model-api` is neither declared nor pinned: an agent-task API (for example a future `/agent/v1/tasks`) runs tools and workspaces itself and would need its own executor, not Topsl's model client.

Values are declarations by the service. Topsl treats the document as data: nothing in it is run or followed as an instruction.

## Capability evidence

Each route records, per capability (streaming, tool calls, parallel tool calls, images, reasoning, structured output), one of:

- **unknown**: nothing observed;
- **declared**: the capability document said so;
- **probed**: Topsl's own connection test saw it.

Every observation records its source, model, protocol, time and the route configuration it was made under: connection, URL, protocol, authentication method, model, adapter revision, account and remote pin. When any of these changes, the observation reads as **unknown (earlier configuration)**. A declaration never replaces a current probe.

**Test route** is the explicit connection test. After Topsl's confirmation it sends three requests, each capped at 64 output tokens and each listed under **Recent requests**: a one-word streamed answer, a forced call to a test tool, and an answer in a one-field JSON schema. Authentication, quota and availability failures leave the result unknown. A refused request, a missing tool call, or an answer that does not match the schema records the capability as unsupported. One conforming answer shows that the route accepted the request, not that every later answer will conform; the harness validates structured answers in every case.

What needs evidence:

- **Native tasks** you start yourself run with unknown capabilities.
- **Team, session and loop members** on an external service need **probed** tool calls, because every member turn uses tools. A member that answers in a schema (every purpose except direct chat) also needs a **probed** structured answer. A declaration is not enough. Until then the route shows **Not ready** with the reason in role selection, and the harness refuses to start the member.

## Remote route pinning

When the document declares `extensions.route_revision_pinning: true` and a `route_revision` for the route, Topsl freezes that revision into the route. The pin is part of the route's revision, so changing it invalidates bound tasks.

- Every inference request carries `X-Gateway-Route-Revision: <revision>`.
- The service must refuse a mismatch with **HTTP 409 before calling its upstream**. Topsl reports the 409 as a changed route, without fetching a new revision or replaying.
- On an accepted answer the service must echo the same header. Topsl checks it before reading any body. A missing or different echo discards the whole answer, so no text or tool call reaches the harness. It is reported as a failure that is not retried, because the service may already have run the request.
- Without the extension Topsl pins only its own configuration. It cannot prove that the service did not change its internal routing.

A route revision should change for any semantic change of the service's route: upstream account, model or funding. Ordinary renewal of the service's own upstream credentials within the same account need not change it.

## Not covered

- Live qualification of any external service.
- Price, allowance or reset-time reporting.
- Editing a connection's URL, protocol or authentication method in place (add a new connection instead).
- Agent-task APIs.
