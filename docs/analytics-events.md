# Analytics event contract

This is a schema and trigger contract only. Milestone 0 sends no analytics and
does not install an analytics provider or consent banner.

## Shared envelope

Every event uses a versioned schema and a unique deduplication key. Permitted
common properties are `schema_version`, `event_id`, `occurred_at` (UTC),
`anonymous_session_id` only where consent permits, and coarse, sanitized
campaign attribution. Do not send email, credentials, IP/device fingerprints,
free text, question or answer content, or unnecessary personal data.

Optional tracking requires market-appropriate consent. Consent withdrawal stops
future optional events; it does not delete or shorten the retention of events
already stored, which keep their full 12-month window (owner decision, 18
November 2026). That window is enforced in storage: `pilot_events_no_delete`
refuses any delete of a row inside it, and a scheduled prune removes rows older
than it — off unless `PILOT_EVENTS_RETENTION_ENABLED` is `"true"`, and the trigger
enforces the period either way. Events never block learning or checkout.
Purchase/access events originate from verified server processing, not a browser
return page. Finance reporting reconciles to orders and provider records, not
analytics.

## Event dictionary

| Event | Trigger | Safe event-specific properties |
|---|---|---|
| `exam_viewed` | Public exam detail is rendered | approved `exam_id`, `exam_version` |
| `sample_started` | An explicitly approved public sample begins | approved `exam_id`, `sample_id` |
| `sample_completed` | The approved sample completes | approved `exam_id`, `sample_id`, result band |
| `signup_completed` | Server confirms account creation | opaque internal account reference only if consented |
| `checkout_started` | Server creates a checkout for a published product | opaque `order_id`, `product_id`, `currency`, amount |
| `purchase_confirmed` | Verified provider event is durably accepted | `order_id`, `product_id`, `currency`, amount, provider event ID |
| `practice_completed` | Server records completion | `exam_id`, `exam_version`, question count band |
| `mock_completed` | Server locks a completed mock attempt | `exam_id`, `profile_version`, question count band |
| `pro_activated` | Server grants verified Pro access | `exam_id`, `product_id`, opaque `order_id` |
| `pro_simulation_completed` | Server records a completed Pro simulation | `exam_id`, profile version, question count band |
| `access_renewed` | Server records a verified access extension | `exam_id`, product ID, opaque order ID |

Define identity linkage, currency handling, retention, attribution model,
reporting timezone, staff/test traffic exclusion and production deduplication
before enabling a provider. The event names above are not evidence that these
flows exist.
