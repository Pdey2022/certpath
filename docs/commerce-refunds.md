<!-- Design by ARC, committed with the implementation PR as the design record.
     Two chat-only passages were removed when it was committed: the sentence naming
     which files had been read, and the blockquote saying the design could not be
     written to the repo. Nothing else was edited. -->

# PR B3 — Refunds with access revocation
**Satisfies** issue #47 Phase 4 PR B3, and (per the brief) #82 and #79.
**Branch** `feat/commerce-refunds` · **migration** `0020_refunds.sql` · **base** `main = 6df3128`
**Status** design for DEV. Two items are owner questions (§14); everything else is decided here and DEV implements it without guessing.


---

## 1. Scope

**In.** `commerce_refunds`, `commerce_refund_lines`, the one-per-exam partial index, one refund receipt per refunded checkout, `paid → refunded` + `failed → paid` + `failed → needs_support` in a **replaced** transition trigger, `commerce_checkouts_refunded_requires_settled_refund`, the #79 integrity rule for `commerce_receipts.refund_id`, `POST /api/commerce/checkouts/:checkoutId/refund`, `GET /api/commerce/receipts?certificationId=`, `GET /api/commerce/receipts/:receiptId`, the expansion of a refund to a dependent Pro checkout, Pro-before-Standard revocation, and the widening of five settlement predicates that makes `failed → paid` real rather than decorative.

**Not in.** Explicitly refused, not quietly absorbed:

| Refused | Where it belongs |
|---|---|
| Refunds of `needs_support` checkouts, and the resolution policy for parked money | **#83.** Owner decision recorded in `docs/open-decisions.md` (two bullets: "resolution policy" and "which clock starts the refund window"). B3 must not invent either. |
| Staff-initiated refunds, goodwill credits, partial/line-level refunds, refunds outside 7 days | Phase 5 admin commerce. The schema leaves room (`requested_by_user_id`), no route, no capability, no new capability name. |
| Any provider that moves real money, any secret provisioning, any deployment, any email | Owner only. `provider.refund` against the fake is the only adapter exercised. |
| UI of any kind (refund button, receipt page, confirmation copy) | Phase 5. The owner-approved sentence "Your refund also cancelled Pro, which was refunded in full" is carried in the API as `includedBecause`, never rendered. |
| Re-entry into `needs_support`, `refunded → anything`, `failed → expired` | Terminology: terminal states stay terminal. |
| Tax, invoicing, consumer-law withdrawal rights, per-market refund policy | ADR 0003 consequences — still open, still not computed, still no column. |

**Scope gap I could not close:** I have no network path to the issue tracker from this environment (`github.com` and `api.github.com` are blocked), so I could not read the bodies of #73/#74/#75/#79/#82/#83/#85/#86. I inferred #74 (one open checkout per `(learner, cert, SKU)`), #79 (receipt `refund_id` integrity) and #83 (parked money) from 0019's header and `docs/commerce.md` §"Arrives in the next commerce change". **If #82 names anything beyond "refund endpoint + revocation", confirm it before DEV starts** — otherwise B3 ships short of an issue it claims.

---

## 2. Decision

A refund is two transactions with a provider call between them, and **the ledger decides, not the provider**. Batch 1 records the *decision* — `commerce_refunds` (`requested`) plus one `commerce_refund_lines` row per checkout — where the one-per-exam index, the "inside the stored window" trigger and the "paid checkout of this learner, this exam, this currency, this exact amount" trigger all bite. Then `provider.refund` is called with our refund id as its idempotency key. Then batch 2 does what has to be one atomic act: revoke **Pro before Standard**, settle the refund under a compare-and-swap, move each checkout to `refunded` (which storage refuses unless a settled refund names it), and write one refund receipt per checkout (which storage refuses unless the refund is settled and the amount agrees). The refund unit is the **entitlement**, which can be two checkouts: revoking the Standard grant that is a Pro grant's only cover aborts at `learner_access_grants_revoke_keeps_pro_covered` (0014), so the dependent Pro checkout is refunded in the same record rather than refused; the expansion is legal because a first purchase's grant can never start before its own `paid_at` and never after the Pro window it covers — re-proved under calendar months in §5 — and the runtime re-checks it anyway and refuses `409` if the arithmetic ever breaks. A refund revokes rather than expires, so `evaluateAccess` filters the grant out and the learner is locked with **no grace**, because ADR 0005's grace is defined for expiry of a grant that is still there. Payments we cannot apply keep their money: `failed → paid` and `failed → needs_support` become legal, so a second `checkout.completed` grants or parks, never vanishes.

**Verdicts on the three orchestrator decisions.**

1. **B3 refunds `paid` only; `needs_support` stays out — agree.** Its resolution policy and its refund-window clock are both open (#83, `docs/open-decisions.md`). Two conditions: (a) `GET /checkouts/:id` currently reports `refundWindowEndsAt = paid_at + 7d` for a `needs_support` row, i.e. it advertises a window no route honours — record that in `docs/commerce.md` rather than silently leaving it (§13); (b) the one-per-exam index must be scoped `requested_by_user_id = user_id`, so a later staff/manual resolution for the same exam is *not* blocked by a learner's earlier refund. The index as specified does exactly that.
2. **`failed → paid` becomes legal — agree, and it is worth more than the migration.** The edge alone is dead code: `standardGrantStatement`, `proGrantStatement`, `transitionStatement`, `eventStatement`'s `retryable` and `markNeedsSupport` all filter `status IN ('pending','expired')`, so a `failed` row would still write nothing and the money would still sit only in `commerce_provider_events`. **Five predicates must widen in the same PR** (§3.5). Without that, the migration ships a rule the code does not use — the exact failure the brief warned about in reverse.
3. **`failed → needs_support` becomes legal — agree**, same widening (`markNeedsSupport`), same reason: park, don't strand.

**Things I decide and record** (cheap to reverse, no product rule): the index excludes `failed` (§3.4, flagged for confirmation); a `requested` refund is *resumed*, not returned as a blanket 202 (§4.2); one refund receipt **per refunded checkout** rather than one per refund (§3.3); `refundWindowEndsAt` is `null` on a checkout read once it is `refunded` (§8.4); `409 refund_rejected` exists for a definitive provider decline (§8.2).

**One thing I will not decide** — a refund that would leave a paying learner with *future but not present* coverage (§14, owner question 1).

---

## 3. Data changes — `db/migrations/0020_refunds.sql`

Additive plus **three replacements** and **one new trigger on an existing table**. No table rebuild, no data copy, no dropped constraint. Nothing in 0013/0014/0019 is relaxed. `certifications` untouched. `learner_access_grants` gains **no** trigger in this migration (0014's two are load-bearing exactly as they are — see 3.6).

### 3.1 `commerce_refunds`

```sql
CREATE TABLE commerce_refunds (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  certification_id TEXT NOT NULL REFERENCES certifications(id) ON DELETE RESTRICT,
  -- Who asked. Equal to `user_id` for every self-serve refund, which is the
  -- predicate of the one-per-exam index below; a future staff refund writes the
  -- staff member's id here and is exempt without an index rewrite.
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('requested', 'settled', 'failed')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  -- The sum of the lines. Asserted at settle time, not trusted.
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- Learner-supplied free text. Capped at the contract's limit, and it must
  -- never reach audit_events (0013's revoke trigger hardcodes its reason).
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  -- "refund:<id>". Opaque, unique, and never derived from the provider.
  operation_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  provider_refund_id TEXT UNIQUE,
  requested_at INTEGER NOT NULL,
  settled_at INTEGER,
  -- A settled refund is one the provider confirmed; a requested one is a
  -- decision we are still collecting on; a failed one is a definitive "no
  -- money moved" and is the only terminal state that may be retried.
  CHECK (status <> 'settled'
         OR (settled_at IS NOT NULL AND provider_refund_id IS NOT NULL)),
  CHECK (status <> 'requested'
         OR (settled_at IS NULL AND provider_refund_id IS NULL)),
  CHECK (status <> 'failed'
         OR (settled_at IS NULL AND provider_refund_id IS NULL)),
  CHECK (settled_at IS NULL OR settled_at >= requested_at)
);
```

Indexes: `commerce_refunds_user_idx ON commerce_refunds(user_id, requested_at DESC, id DESC)` for the read path, and:

```sql
-- Owner decision 1: one self-serve refund ever per (account, exam).
-- `status <> 'failed'` is the one refinement I am making to the approved text
-- (owner question 2, §14): a provider decline that moved no money must not
-- consume a learner's statutory refund. A *settled* row can never be bypassed:
-- two settled rows for one (account, exam) both sit in this index, so the
-- second insert aborts.
CREATE UNIQUE INDEX commerce_refunds_one_per_exam
  ON commerce_refunds(user_id, certification_id)
  WHERE requested_by_user_id = user_id AND status <> 'failed';
```

### 3.2 `commerce_refund_lines`

```sql
CREATE TABLE commerce_refund_lines (
  refund_id TEXT NOT NULL REFERENCES commerce_refunds(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
  checkout_id TEXT NOT NULL REFERENCES commerce_checkouts(id) ON DELETE RESTRICT,
  -- A refund is always the full price of the checkout (ADR 0003: no partial
  -- periods, no line-level refunds). A trigger below makes that equality an
  -- invariant rather than a comment.
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- The deadline this line was let in under: `paid_at + refundWindowMs`, copied
  -- from `pricing.ts` by the writer. Stored rather than recomputed so the
  -- "inside the window" trigger needs no second copy of the seven-day constant
  -- in SQL - the defect class this repo keeps paying for. The *value* is
  -- JS-owned and asserted by a test; the *ordering* is storage-owned.
  window_ends_at INTEGER NOT NULL,
  PRIMARY KEY (refund_id, position),
  UNIQUE (refund_id, checkout_id)
);

CREATE INDEX commerce_refund_lines_checkout_idx
  ON commerce_refund_lines(checkout_id);
```

`position BETWEEN 0 AND 3`: the lemma caps the set at two checkouts (§5.3) and the planner refuses beyond two, so the range is slack on purpose — a CHECK that aborts a legitimate refund would be worse than a loose bound.

**Invariants enforced at storage, with the failure mode if the code is wrong:**

| Trigger | Rule | Failure mode if application code is wrong |
|---|---|---|
| `commerce_refund_lines_validate_insert` (`BEFORE INSERT`) | abort unless the line's checkout is `paid`, belongs to the refund's `user_id` / `certification_id` / `currency`, `amount_minor = checkout.total_minor`, and `refund.requested_at < NEW.window_ends_at` | a route that refunds a `pending`/`refunded` checkout aborts; a partial refund aborts; a refund decided after the deadline aborts. |
| `commerce_refund_lines_not_already_settled` (`BEFORE INSERT`) | abort if the checkout already appears in a **settled** refund | a checkout can never be paid back twice, including via a future staff path where the one-per-exam index does not apply. This is the guard that survives the staff route being added. |
| `commerce_refund_lines_no_update` / `_no_delete` | append-only | the set of checkouts a settled refund covered is not editable after the money moved. |
| `commerce_refunds_immutable_update` | only `status`, `settled_at`, `provider_refund_id` may change, and only while `OLD.status = 'requested'` | a retry cannot re-price a refund or re-point it at another exam. |
| `commerce_refunds_status_transition` | `requested → {settled, failed}` only | `settled` and `failed` are terminal; a timeout cannot be "re-decided" into `failed` after the fact. |
| `commerce_refunds_no_delete` | append-only | the money record cannot be erased. |

### 3.3 Refund receipts and #79 (`commerce_receipts.refund_id`)

**One refund receipt per refunded checkout, all sharing the same `refund_id`.** Reason: `UNIQUE (checkout_id, kind)` already says "one refund receipt per checkout"; if an expanded refund wrote a single receipt attached to the named checkout, the companion checkout would keep a purchase receipt and no refund receipt, so `GET /receipts` would show one of the two cancellations and not the other. Per-checkout receipts make every checkout's history self-consistent and let the receipt's `total_minor` equal that checkout's refunded amount.

Field shape for kind `'refund'`: `refund_id` non-null (0019's CHECK), `refund_window_ends_at` **must be null** (0019's CHECK ties that column to `kind='purchase'`, so a refund receipt with a window aborts) — both confirmed against the loaded schema. `provider_ref` carries the provider's **refund** reference (`commerce_refunds.provider_refund_id`), not the session id; the column means "the provider's opaque reference for the money movement this receipt records". `receipt_number` is derived per row from that row's own id and `issued_at`, so two receipts for one checkout (purchase + refund) get different numbers, and the same checkout refunded twice is impossible by 3.2's index and trigger. Uniqueness remains a constraint; a same-day collision aborts the batch (2⁻⁴⁸ per pair) rather than minting a duplicate.

**#79 — trigger, not a 12-step rebuild.** Recommended:

```sql
CREATE TRIGGER commerce_receipts_refund_references_settled_refund
BEFORE INSERT ON commerce_receipts
WHEN NEW.kind = 'refund'
BEGIN
  SELECT RAISE(ABORT, 'a refund receipt requires a settled refund for this checkout')
  WHERE NOT EXISTS (
    SELECT 1
    FROM commerce_refunds AS refund
    JOIN commerce_refund_lines AS line ON line.refund_id = refund.id
    WHERE refund.id = NEW.refund_id
      AND refund.status = 'settled'
      AND refund.user_id = NEW.user_id
      AND refund.certification_id = NEW.certification_id
      AND refund.currency = NEW.currency
      AND line.checkout_id = NEW.checkout_id
      AND line.amount_minor = NEW.total_minor
  );
END;
```

*Cost of the alternative.* Rebuilding `commerce_receipts` means: create a new table restating four CHECKs, two UNIQUE constraints, the status/money tie and the two `kind` ties; copy every receipt (including refund receipts that cannot exist yet, so the copy is pure purchase data); `DROP TABLE` — **which silently drops `commerce_receipts_no_update` and `commerce_receipts_no_delete`** — then rename, recreate both triggers and `commerce_receipts_user_idx`, and recreate the FK to `commerce_checkouts`/`users`/`certifications`. A FK also cannot express the three things this rule actually needs: that the refund is **settled**, that the receipt and the refund agree on learner/exam/currency, and that the receipt's total equals the refund line for that checkout. So the FK would be a weaker rule bought with a rebuild whose most likely mistake is losing an append-only trigger — this repo's named bug class. **Cost of the trigger: zero migration risk, one rule expressed once, and it is strictly stronger than a FK.** The docs sentence in `docs/commerce.md` ("0020 must either rebuild … or enforce it with a trigger") is settled by this choice and must be rewritten.

### 3.4 `commerce_refunds_one_per_exam` semantics

- Two *different* checkouts for one exam cannot both be refunded self-serve, now or ever, whichever SKU they were.
- Repeating the *same* checkout's refund is not a second refund row — it is a replay that returns the stored refund (§4.2). The route must not depend on the index to produce that answer; it reads first, and the index is the race-safe backstop.
- A `failed` row does not consume the cap (owner question 2).
- Staff refunds (`requested_by_user_id <> user_id`) are outside the index by construction, so #83's manual resolution is additive.

### 3.5 The replaced `commerce_checkouts_status_transition` — every legal edge

```sql
DROP TRIGGER commerce_checkouts_status_transition;

CREATE TRIGGER commerce_checkouts_status_transition
BEFORE UPDATE OF status ON commerce_checkouts
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'pending'
      AND NEW.status IN ('paid', 'failed', 'expired', 'needs_support'))
  OR (OLD.status = 'expired' AND NEW.status IN ('paid', 'needs_support'))
  OR (OLD.status = 'failed'  AND NEW.status IN ('paid', 'needs_support'))
  OR (OLD.status = 'paid'    AND NEW.status IN ('refunded', 'needs_support'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal checkout status transition');
END;
```

Every edge 0019 added is restated verbatim — in particular **`expired → needs_support` must survive**, because that is the bug class caught last round: a replacement that re-narrows it turns a parked late payment back into a permanent 5xx with the learner's money already taken. The test plan re-asserts that edge explicitly (§12.4). `refunded`, `failed`-as-target-from-anything-else, and `needs_support → *` remain illegal.

Plus one **new, separately named** trigger (a different rule, not a replacement):

```sql
CREATE TRIGGER commerce_checkouts_refunded_requires_settled_refund
BEFORE UPDATE OF status ON commerce_checkouts
WHEN NEW.status = 'refunded'
BEGIN
  SELECT RAISE(ABORT, 'a refunded checkout requires a settled refund')
  WHERE NOT EXISTS (
    SELECT 1 FROM commerce_refund_lines AS line
    JOIN commerce_refunds AS refund ON refund.id = line.refund_id
    WHERE line.checkout_id = NEW.id AND refund.status = 'settled'
  );
END;
```

Two BEFORE UPDATE triggers on `commerce_checkouts` is correct **here** and is not the 0019 anti-pattern: 0019 replaced its rule rather than sitting a second copy beside it. These are two distinct rules (edge legality vs. a witness requirement), each named for what it enforces.

**The five settlement predicates that must widen in `apps/api/src/commerce/webhooks.ts`** (otherwise `failed → paid` is inert):

| Function | Current | Becomes |
|---|---|---|
| `standardGrantStatement` | `checkout.status IN ('pending','expired')` | `IN ('pending','expired','failed')` |
| `proGrantStatement` | same | same widening |
| `transitionStatement` | same | same widening |
| `eventStatement` (`retryable`) | `open.status IN ('pending','expired')` | same widening, so a lost CAS on a `failed` row retries instead of parking |
| `markNeedsSupport` | `status IN ('pending','expired')` | `IN ('pending','expired','failed')` |
| `settleCompletedEvent` final check | `latest.status === 'pending' \|\| 'expired'` | add `'failed'` |

`applyFailure` keeps `WHERE status = 'pending'`: a `checkout.failed` must never move a `paid` or `refunded` row backwards. `expire.ts` is unchanged (only `pending`).

### 3.6 What this migration deliberately does **not** add to `learner_access_grants`

No new trigger. 0014's `learner_access_grants_revoke_keeps_pro_covered` is the storage guard for the Pro-before-Standard ordering, and the refund's concurrency guard is a compare-and-swap inside the settle statement (§4.3) — not a third definition of coverage at the grant layer. Adding a "contiguity" trigger here would be the first copy of a rule that `pricing.ts` already owns (§14).

---

## 4. The refund protocol

Files: `apps/api/src/commerce/refunds.ts` (new), `apps/api/src/commerce/receipts.ts` (new), `apps/api/src/commerce/http.ts` (two routes), `packages/contracts/src/commerce.ts` (§8).

### 4.1 Decision steps, in order (no writes in 1–6)

1. **Resolve the checkout, owner-scoped.** `SELECT … FROM commerce_checkouts WHERE id = ? AND user_id = ?`. Zero rows → `404 checkout_not_found` (indistinguishable from another learner's id, and from an id failing `^[a-zA-Z0-9:_-]{1,128}$`).
2. **Replay a settled refund.** `SELECT refund.* FROM commerce_refund_lines line JOIN commerce_refunds refund … WHERE line.checkout_id = ? AND refund.status = 'settled'`. Found → build the 200 from storage (§4.4) and **do not call the provider**.
3. **Resume a requested refund.** Same query with `status = 'requested'`. Found → jump to §4.3 with the stored refund id. *The provider is called again, with the same idempotency key*, because a timeout is an unknown outcome and only the provider can resolve it. The window is **not** re-checked: the decision was taken inside it.
4. **Eligibility.** `status = 'paid'` else `409 refund_not_allowed`; `now < paid_at + refundWindowMs` else `400 refund_window_closed`; no other non-`failed` refund for `(user, certification)` else `409 refund_already_used`.
5. **Plan the set** (§4.2) including the expansion and the coverage-gap guard.
6. **Batch 1 — record the decision** (one transaction):

```sql
-- witness: RETURNING id
INSERT INTO commerce_refunds (
  id, user_id, certification_id, requested_by_user_id, status, currency,
  amount_minor, reason, operation_id, provider, provider_refund_id,
  requested_at, settled_at)
VALUES (?1, ?2, ?3, ?2, 'requested', ?4, ?5, ?6, ?7, ?8, NULL, ?9, NULL)
RETURNING id;
-- one per checkout, position = plan order (refunded checkout first)
INSERT INTO commerce_refund_lines (
  refund_id, position, checkout_id, amount_minor, window_ends_at)
VALUES (?1, ?2, ?3, ?4, ?5);
```

   The unique index is the witness that no second refund exists for the exam; a `UNIQUE constraint failed` here is re-read as `409 refund_already_used` or, if the winner is now this checkout's refund, as the replay path.
7. **Provider call**, outside any transaction: `provider.refund({ refundId, payments: plan.map(l => ({ sessionRef: checkout.provider_session_id, amountMinor: l.amountMinor })), totalMinor, currency, reason })`. The refund id is the idempotency key, so a crash before batch 2 is safe.
8. **`failed` / `rejected`**: batch of one statement — `UPDATE commerce_refunds SET status = 'failed' WHERE id = ? AND status = 'requested'`. Nothing revoked, nothing settled, no receipt, no checkout change. Answer `503 provider_unavailable` (`failed`) or `409 refund_rejected` (`rejected`). The cap is not consumed, so a retry is a new refund row.
9. **`succeeded`**: batch 2 (§4.3), retried up to 3 times on a constraint abort, then §4.4.

**Timeout / throw from `provider.refund`:** the refund stays `requested` — *never* `failed`, because "maybe moved" is not "did not move" — access stays live, and the answer is `202 refund_pending` with the same `refundId`. Losing access without money returning is the worse error, so the fail-closed direction is to keep the entitlement until the provider confirms.

### 4.2 The refund set: expansion, staff grants, and the gap guard

```
set = [named checkout]
repeat (at most 3 iterations, then 409):
  proToRevoke  = non-revoked pro grants for (user, exam) whose operation_id is
                 "<checkoutId>:pro" for a checkout in set
  stdToRevoke  = non-revoked standard grants for (user, exam) whose operation_id is
                 "<checkoutId>:standard" for a checkout in set
  atRisk       = non-revoked pro grants for (user, exam) that
                 (a) are currently covered by some grant in stdToRevoke, and
                 (b) would have no remaining non-revoked standard grant with
                     starts_at <= pro.starts_at AND expires_at >= pro.expires_at
                     (0014's predicate, verbatim)
  for each g in atRisk:
     if g.source NOT IN ('purchase','bundle') OR g.operation_id does not end ':pro'
        OR the checkout does not exist OR its status <> 'paid'
        OR now >= checkout.paid_at + refundWindowMs
        -> 409 refund_requires_support
     else add that checkout to set
```

- `source = 'grant'` (a Global Admin's staff grant) or a non-checkout operation id is **`409 refund_requires_support`** — revoking a staff commercial act as a side effect of a learner's self-serve action is not ours to do. Same for a dependent checkout outside its own window: the lemma says that cannot happen, so if it does the arithmetic is broken and we refuse rather than act on it.
- **Bound:** at most **two** checkouts. Every companion has `paid_at ≥ named.paid_at` (§5.2) and `< named.paid_at + 7 days`, and two Pro-granting purchases inside any seven-day span overlap, which `learner_access_grants_one_pro_window` (0019) forbids. The planner asserts the bound; exceeding it is `409 refund_requires_support`, never a third line.
- **Coverage-gap guard (owner question 1).** After removing `stdToRevoke` from the learner's non-revoked Standard grants, if **no** remaining grant is live at `now` **and** a remaining grant starts in the future → `409 refund_requires_support`. Reason: every Standard purchase appends to the latest end (`standardCoverageEndMs` floors at `now`), so a gap can never be bought back; granting the refund would leave a paying learner locked out with no purchasable route back until the later window starts.
- **The revoke set is defined by operation id, never by "live at now".** A refund must revoke exactly what the refunded checkouts granted, including a grant that has already expired or has not started — a clock-dependent set would make the same refund revoke different rows on a retry.

### 4.3 Batch 2 — settle and revoke, statement by statement

One `database.batch()`, one transaction, ordered so every witness reads a write this transaction made:

| # | Statement | Witness |
|---|---|---|
| 1 | One `UPDATE learner_access_grants SET revoked_at=?, revocation_operation_id='refund:<refundId>:<grantId>', revoked_by_user_id=<learner> WHERE id=? AND revoked_at IS NULL RETURNING id` per **Pro** grant | 1 row per planned Pro grant |
| 2 | Same, per **Standard** grant | 1 row per planned Standard grant |
| 3 | `UPDATE commerce_refunds SET status='settled', settled_at=?, provider_refund_id=? WHERE id=? AND status='requested' AND amount_minor = (SELECT COALESCE(SUM(amount_minor),0) FROM commerce_refund_lines WHERE refund_id=?) AND (SELECT COUNT(*) FROM learner_access_grants WHERE revocation_operation_id IN (<exact planned ids>)) = <expected> AND (SELECT COUNT(*) FROM learner_access_grants WHERE user_id=? AND certification_id=? AND feature='standard' AND revoked_at IS NULL) = <remainingStandardCount> RETURNING id` | exactly 1 row |
| 4 | One `UPDATE commerce_checkouts SET status='refunded', updated_at=? WHERE id=? AND status='paid' RETURNING id` per checkout | 1 row per checkout |
| 5 | One refund-receipt `INSERT … SELECT … WHERE refund.status='settled' AND NOT EXISTS(refund receipt for this checkout)` per checkout | 1 row per checkout |

Why this order and not another:

- **1 before 2** because `learner_access_grants_revoke_keeps_pro_covered` (0014) aborts a Standard revocation that would leave a live Pro uncovered. Reversing them aborts — deliberately, and a test proves it.
- **3 after 1–2** because 3 counts the grants carrying this refund's revocation operation ids; a revocation that silently matched nothing (already revoked, wrong id) makes the count short, 3 matches zero rows, and then …
- **4 after 3** because `commerce_checkouts_refunded_requires_settled_refund` aborts a `refunded` transition without a settled refund — so statement 4 *fails the whole batch* when 3 lost, instead of committing a refunded checkout with live access.
- **5 after 3** because the #79 trigger aborts a refund receipt whose refund is not settled, and it also aborts a receipt whose total disagrees with the refund line. Same property, second witness.
- The CAS in 3 is the concurrency guard: `remainingStandardCount` is what the plan expects to remain, so a Standard grant that a concurrent settlement appended between plan and batch makes 3 match nothing, which makes 4 abort, which triggers the retry loop of §4.1 step 9 — and on the retry the plan sees the new grant and either includes it or refuses with the gap guard. **The Pro race is already guarded by 0014** (a concurrent Pro insert that our Standard revocation would uncover aborts the batch), so the retry loop re-plans and finds the companion. Two races, two different, existing guards — no new trigger.
- `revocation_operation_id` is per grant (`refund:<refundId>:<grantId>`) because `learner_access_grants.revocation_operation_id` is `UNIQUE` and `audit_events.operation_id` is a **primary key**: one id per audit row. `0013`'s revoke trigger then writes one `access_revoked` audit row per grant, with the learner as actor and the reason hardcoded `'Access revoked'` — **the learner's free-text `reason` never reaches the audit table**, which is the property that makes the 1..200 `reason` safe to accept at all.

### 4.4 The response is a projection of storage

After a successful settle — and for every replay — the handler re-reads: the refund row, its lines (with `checkout.sku`), the checkouts in `set`, the grants whose `revocation_operation_id` begins with `refund:<refundId>:` (compared with `substr(revocation_operation_id, 1, ?len) = ?prefix`, **not** `LIKE`, whose default case-insensitivity would make it a different predicate), and the refund receipts by `checkout_id`. One code path builds the body, so a fresh settle and a replay cannot diverge, and no state is trusted from the request.

---

## 5. The expansion lemma, re-verified under calendar months

### 5.1 Statement

> Let a self-serve Standard refund be legal at instant `t` (so `t < s + 7d`, where `s` is the refunded checkout's `paid_at`). Let `P` be a Pro grant that revoking that purchase's Standard grant would leave uncovered. Then `P`'s purchase is also inside its own window: `p ≤ t < p + 7d`, where `p` is the Pro checkout's `paid_at`.

### 5.2 Proof (the original proof's middle step was not justified; here is the argument that is)

Let `G` be the Standard grant produced by the refunded checkout and `P` the Pro grant it covers.

1. **`G.starts_at ≥ s`.** This is a property of `planSettlementWindows`, not of the term: a non-bundle Standard leg starts at `coverageEnd = standardCoverageEndMs(grants, now) ?? now`, and `standardCoverageEndMs` returns `Math.max(end, now)` — never before `now`; the bundle's Standard leg starts at exactly `now`. Either way `starts_at ≥ now = s = paid_at`. **This is why the lemma holds under calendar months at all**: the old proof used `s + 7d ≤ p + 7d`, which needs only `s ≤ p`, and under day arithmetic it was tempting to read `p ≥ s` straight off "the window is `[s, s + days)`" — true then, false now. The window length is irrelevant; the anchor of `starts_at` is everything.
2. **`G.starts_at ≤ P.starts_at = p`.** `G` is the grant `P` depends on, and `learner_access_grants_pro_requires_standard` (0013) accepted `P` only because some non-revoked Standard grant satisfies `starts_at ≤ P.starts_at AND expires_at ≥ P.expires_at`. That grant is `G` — if it were another grant, then after revoking `G` the Pro would still be covered and it would not be in `atRisk`.
3. So `s ≤ G.starts_at ≤ p`, hence `s ≤ p`, hence `s + 7d ≤ p + 7d`.
4. `p ≤ t` because `p` is a `paid_at` in the past. With `t < s + 7d` we get `t < p + 7d`. Together: `p ≤ t < p + 7d`. ∎

### 5.3 Consequences, and what must be tested rather than assumed

- **The lemma is load-bearing on premise (1)**, which nothing in storage enforces. If any code path ever wrote a grant starting before its own checkout's `paid_at` (a backdated grant closing a lapse would look reasonable), the lemma fails and a refund could silently take money on a purchase outside its window. So: an acceptance criterion and a test — *every purchase-written grant satisfies `grant.starts_at >= checkout.paid_at`* — and the runtime re-check in §4.2 that refuses `409 refund_requires_support` instead of acting. The lemma is the argument for the design; the re-check is the guarantee.
- **At most one companion** (needs §5.2 plus 0019's one-Pro-window trigger, as in §4.2).
- **A bundle can never be a companion**: its Pro leg is covered by its own Standard leg, which starts at the same instant, so revoking someone else's Standard grant never uncovers it.
- Under calendar months the arithmetic of the *term* (89-day Feb, 92-day Jul, clamping) never enters the proof, which is why the migration of `pricing.ts` to `addTerm` did not weaken it.

---

## 6. Revocation order and staff-granted Pro

- **Pro first, then Standard, always** — including when the refund set is a single Pro-only checkout (then there is no Standard step) and when it is a bundle (its own Standard leg covers its own Pro leg, so revoking the Pro first also satisfies 0014; doing it the other way round would abort). 0014's trigger is the storage statement of the rule; the batch's order is the implementation of it; a direct-SQL test proves the reverse order aborts with `revoking this standard grant would leave a pro grant uncovered`.
- **Staff-granted Pro in the way → `409 refund_requires_support`, nothing written.** Detection is by provenance, not by person: `learner_access_grants.source` must be `'purchase'` or `'bundle'` *and* the `operation_id` must resolve to a `paid` checkout. A grant with `source = 'grant'`, `'migration'`, `'extension'`, or an operation id that does not end `:pro` is a grant whose money we cannot give back, so the learner's self-serve action may not cancel it. The answer carries the code and no detail; the case is support's. This is the same code, for the same reason, as a dependent checkout outside its window.
- **No new capability, no new route**: a staff path stays Phase 5. `docs/permissions.md` does not change (its commerce table is admin-only and unchanged).
- **`evaluateAccess` after the refund has no grace**: see §7.

---

## 7. Access after refund

`evaluateFeature` (`apps/api/src/entitlements.ts`) begins with `grants.filter(g => g.feature === feature && g.revokedAt === null)`. A revoked grant is therefore not merely inactive, it is **absent**: with no other grant, `relevant.length === 0` and the function returns the shared `expired` constant — `{ state: 'expired', startsAt: null, endsAt: null, graceEndsAt: null }`. `grace` is reachable only from a grant that is still **there** and expired within 15 days, so a revocation can never produce it. Consequences, all verified against the shipped code:

- `can(access, 'results')` is `false` (`standard !== 'expired' || pro !== 'expired'` with both expired) — no read-only residue.
- `can(access, 'practice')` and `can(access, 'mock')` are `false` (`standard === 'active'`).
- `GET /api/practice/dashboard` omits the exam: its grant query already selects `WHERE revoked_at IS NULL`, so the refunded grant is not merely filtered by `can(...)`, it is not in the map; and `if (!can(access, 'results')) continue;` skips the group.
- `0013`'s practice/mock insert triggers re-check `revoked_at IS NULL AND starts_at <= at AND expires_at > at`, so a mid-attempt learner's next answer is rejected — access ends when the refund is processed, which is ADR 0003's sentence, not a bug to route around.

**How a test proves it** (§12.1 #3): a learner whose *only* grant is the refunded one; assert `evaluateAccess(grants, now)` returns `state === 'expired'` **and** `graceEndsAt === null` **for both features**; assert `can(access,'results') === false`; assert the dashboard returns no group for that certification; assert a fresh practice attempt is refused by storage. Then the **negative twin** (same test file): a learner with two purchases where the *later* one is refunded keeps `state === 'active'` from the earlier grant — proving the refund revoked what was refunded and nothing else. The pair is what distinguishes "refund ends access" from "refund erases the account".

---

## 8. Interface

Contract file: **`packages/contracts/src/commerce.ts`**, re-exported from `packages/contracts/src/index.ts`. All schemas `.strict()`. Errors keep the house envelope `{ error: { code, requestId } }`. Every learner route: `private, no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Request-Id`; every `POST` requires `Origin === PUBLIC_SITE_ORIGIN` and `X-CSRF-Token` (the existing `protectMutation`).

**New exports:** `commerceRefundRequestSchema`, `commerceRefundCheckoutSchema`, `commerceRefundRevokedGrantSchema`, `commerceRefundReceiptRefSchema`, `commerceRefundSettledResponseSchema`, `commerceRefundPendingResponseSchema`, `commerceRefundResponseSchema` (`z.discriminatedUnion("status", […])`), `commerceReceiptLineSchema`, `commerceReceiptGrantSchema`, `commerceReceiptSchema`, `commerceReceiptListResponseSchema`, and the inferred types.

### 8.1 `POST /api/commerce/checkouts/:checkoutId/refund`

Request: `{ "reason": string }` — `.min(1).max(200)`, house rule: no `@` (a free-text field must not become an unlogged email channel). Body cap 8 KiB `application/json`, as the other routes.

**`200` — settled:**

```json
{ "refundId": "rfd_…", "status": "settled", "currency": "USD", "amountMinor": 10800,
  "requestedAt": 1763300000000, "settledAt": 1763300000000,
  "checkouts": [
    { "checkoutId": "chk_…", "sku": "standard-3m", "amountMinor": 5900, "includedBecause": "requested" },
    { "checkoutId": "chk_…", "sku": "pro-3m",      "amountMinor": 4900, "includedBecause": "dependent-pro" } ],
  "revoked": [
    { "feature": "pro",      "grantId": "…", "checkoutId": "chk_…", "startsAt": 1763300000000, "expiresAt": 1765… },
    { "feature": "standard", "grantId": "…", "checkoutId": "chk_…", "startsAt": 1763300000000, "expiresAt": 1765… } ],
  "receipts": [
    { "receiptId": "…", "receiptNumber": "CP20261116-AB12CD34EF56", "checkoutId": "chk_…" },
    { "receiptId": "…", "receiptNumber": "CP20261116-12AB34CD56EF", "checkoutId": "chk_…" } ],
  "access": "ended" }
```

- `checkouts[0]` is always the checkout the learner named; the rest carry `includedBecause: "dependent-pro"` — the machine-readable half of the owner-approved sentence, never rendered here.
- `revoked` is ordered **Pro then Standard**, then `startsAt`, matching execution order.
- `receipts` has one entry per checkout, in the same order.
- `access` has exactly one value, `"ended"`, because the grace question is part of the API, not the presentation layer.

**`202` — requested (provider not yet confirmed, nothing revoked):**

```json
{ "refundId": "rfd_…", "status": "requested", "currency": "USD", "amountMinor": 5900,
  "requestedAt": 1763300000000,
  "checkouts": [ { "checkoutId": "chk_…", "sku": "standard-3m", "amountMinor": 5900, "includedBecause": "requested" } ] }
```

No `revoked`, no `receipts`, no `access`: nothing has happened to access, and saying `"ended"` would be a lie. A client that retries gets the same `refundId` and the same body until the provider answers.

Status codes: `200` settled (including replay) · `202 refund_pending` · `400 validation_error` / `refund_window_closed` / `invalid_origin` / `invalid_csrf` · `401 unauthenticated` · `404 checkout_not_found` · `409 refund_already_used` / `refund_requires_support` / `refund_not_allowed` / `refund_rejected` · `413`/`415` as house style · `503 commerce_disabled` / `provider_unavailable`.

`refund_window_closed` stays `400` (design choice already published in §4.2 of the approved design). `refund_rejected` is new: a provider's definitive decline is not an outage and must not be answered `503`, or a client retries a decision that will not change. It reports the provider's answer and creates no product rule; mapping it to `503` instead is a one-line change if the owner prefers fewer codes.

### 8.2 `GET /api/commerce/receipts?certificationId=`

Query: exactly one `certificationId` (existing `pathIdSchema`), optional `limit` `1..50` (default 50). Unknown exam → `404 certification_not_found`; malformed query → `400 validation_error`.

```json
{ "certificationId": "cissp", "currency": "USD",
  "receipts": [ {
    "receiptId": "…", "receiptNumber": "CP20261116-AB12CD34EF56",
    "kind": "purchase", "checkoutId": "chk_…", "refundId": null,
    "certificationId": "cissp", "currency": "USD", "totalMinor": 9900,
    "lines": [ { "sku": "standard-3m", "label": "Standard, 3 months", "amountMinor": 5900,
                 "feature": "standard", "term": { "unit": "calendar_months", "months": 3 } } ],
    "grants": [ { "feature": "standard", "startsAt": 1763300000000, "expiresAt": 1765…,
                  "operationId": "chk_…:standard", "grantId": null } ],
    "provider": "fake", "providerRef": "fake_chk_…", "delivery": "stored",
    "refundWindowEndsAt": 1763…, "issuedAt": 1763300000000 } ] }
```

Order `issued_at DESC, id DESC`. **`kind: "refund"`** entries: `refundId` set, `refundWindowEndsAt` **null**, `totalMinor` = that checkout's refunded amount, `grants[].grantId` set (the row revoked) and `grants[].operationId` set. **Null rules, stated once:** `refundId` is null exactly for purchases; `refundWindowEndsAt` is null exactly for refunds and non-null exactly for purchases (0019's two CHECKs); `grantId` is null on purchase receipts because the grant row id is minted inside the settlement insert and 0019's shipped writer records only the operation id — the read model normalises `grantId ?? null` and `operationId ?? null`, so the contract stays strict while the stored JSON shapes differ. `providerRef` is null only if a stored row has none (a purchase settled before a provider session was bound cannot happen; a refund always has `provider_refund_id` when settled).

**No cursor.** 50 is the ceiling and a client cannot page past it. I am shipping that deliberately rather than inventing a keyset in this PR: a learner's receipts for one exam are bounded by purchases, and `GET /receipts/:receiptId` serves any single one. `docs/commerce.md` records the limitation and a Phase 5 UI is where a cursor gets designed.

### 8.3 `GET /api/commerce/receipts/:receiptId`

Owner-scoped in the `WHERE` (`receipt_id = ? AND user_id = ?`), so another learner's id is `404 receipt_not_found`, indistinguishable from a nonexistent one. Returns the single receipt object of §8.2 (not wrapped), `200`.

### 8.4 No change to the checkout read? One change.

`toResponse` in `checkouts.ts` must return **`refundWindowEndsAt: null` when `status === 'refunded'`**, as the approved design states ("null again after a refund"). Today it computes `paid_at + refundWindowMs` unconditionally, and `paid_at` is preserved on a refund by 0018's money/status CHECK — so without this delta the API would advertise a refund window for a checkout that has already been refunded. Test: refund, then `GET /checkouts/:id` → `refundWindowEndsAt === null`, `paidAt` unchanged, `status === "refunded"`, `redirectUrl === null`.

A `needs_support` checkout still reports a window that no route honours (B3 refunds `paid` only). That is #83's open policy, not a bug introduced here; it is recorded in the docs rather than silenced in the contract, because the window is a real fact and a client must branch on `status`.

---

## 9. Security

**Who may call what.** The refund route is a learner route inside `createCommerceApi`, behind its existing order: `COMMERCE_ENABLED === "true"`, usable `PUBLIC_SITE_ORIGIN` + `CSRF_HMAC_SECRET`, a resolvable provider, then a live `app_sessions` row for an active user, then `protectMutation` (Origin + CSRF). Receipt reads are the same middleware without the mutation check.

**Where authorization happens.** In the `WHERE` of every statement — `commerce_checkouts.id = ? AND user_id = ?`, `commerce_refunds.user_id = ?`, `commerce_receipts.id = ? AND user_id = ?` — never only in a handler-level `if`. The refund batch's statements are additionally pinned to `user_id`/`certification_id`/`currency` read from the refund row, so a bug in the planner cannot revoke another learner's grant or another exam's.

**What is logged.** Nothing new. If a log line is ever added for this path it may carry `refundId`, `checkoutId`, `provider`, `outcome` — never the reason text.

**What must never be logged, returned, or audited.** The learner's `reason` free text (stored once on their own refund row; **not** copied into `audit_events`, whose revoke trigger hardcodes `'Access revoked'`); the provider refund reference beyond the opaque value in the receipt's `provider_ref`; `COMMERCE_WEBHOOK_SECRET`; the provider session id in any response other than the checkout's own owner-scoped read; any card datum, email address or IP address (no column exists for any of them).

**D1/Worker boundary.** One Worker, one D1, no new binding, no queue, no cron, no `waitUntil`: the provider call happens inside the request so the answer is truthful, and `provider.refund` is idempotent on our refund id so a client retry is safe. No money rule executes in SQL that `pricing.ts` owns — the deadline is carried as a value (`commerce_refund_lines.window_ends_at`) and only the *ordering* is enforced in SQL.

**Cost and exposure.** $0. No new paid plan, no provisioning, no deployment, no secret, no email transport, `provider.live === false` asserted by test. `docs/commerce.md`'s rule that the fake provider is enabled only in the local dev environment is unchanged.

**One asymmetry worth stating.** The refund path is the first place the application *removes* an entitlement on a learner's own instruction. It is designed so that every removal is (a) named by a refund row created before the provider call, (b) audited by 0013's revocation trigger, (c) counted by the settle statement, and (d) irreversible — `learner_access_grants_immutable_update` refuses any change to an already-revoked grant, so "deactivation is terminal" is storage, not discipline.

---

## 10. Failure modes

| Situation | Behaviour |
|---|---|
| **Provider outage mid-refund** (`refund` throws / times out) | Refund stays `requested`; nothing revoked; nothing settled; no receipt; `202 refund_pending` with the same `refundId`. A retry re-calls the provider with the same idempotency key. The window is not re-checked (the decision was already inside it). Access stays live: worse to lose access than to lose speed. |
| **Provider says no** (`failed` / `rejected`) | Refund → `failed`, terminal for that attempt; nothing revoked; `503 provider_unavailable` (`failed`) or `409 refund_rejected` (`rejected`). The one-per-exam cap is **not** consumed (index excludes `failed`), so a retry is a fresh refund row. |
| **Double-click / client retry** | Two requests: the planner reads first (step 2/3), so the second resumes or replays and never creates a second row; under a true race the partial unique index aborts the loser's batch 1, which is re-read as a replay (`200`) or `409 refund_already_used`. The provider is called **once** for a settled refund (asserted by counting fake-provider calls). |
| **Refund racing a second refund for the same exam** (different checkout) | Both may plan; the index admits one. The loser writes nothing — batch 1 aborts *before* the provider call, so no money moves twice. Answer `409 refund_already_used`. |
| **Refund racing a webhook** | A concurrent settlement that appends Standard coverage makes the settle CAS (statement 3) match nothing, which makes the `refunded` transition abort, which retries the plan; the second pass either includes the new purchase or refuses with the gap guard. A concurrent Pro settlement that our Standard revocation would uncover aborts at 0014 and retries into the expansion. A `checkout.completed` for an **already refunded** checkout: `refunded → paid` is illegal, the grant `operation_id` already exists, the receipt already exists — the event is recorded `ignored-inconsistent`, answered `200`, nothing resurrects. |
| **Refund of an already-expired grant** | Allowed and harmless: the revoke set is defined by operation id, not by liveness, so the grant is revoked for the record and `evaluateAccess` was already `expired`. Never a grace-shaped answer; a refund outside the window is `400 refund_window_closed` regardless. |
| **Refund where the learner has since bought again** (a *later* purchase chained on the refunded one) | Refused `409 refund_requires_support` by the coverage-gap guard (§4.2), because no purchase can fill a gap. Nothing moves, access is untouched, support decides. **Owner question 1.** A learner with an *earlier* live purchase simply keeps it: the refund takes away only the refunded window, and `evaluateAccess` stays `active` on the earlier grant. |
| **Lost CAS / any constraint abort in batch 2** | The whole batch rolls back (one D1 transaction): no revocation, no settle, no checkout change, no receipt. Retried up to 3 times with a fresh read, then `503 provider_unavailable` — money already returned by the provider, ledger still `requested`, next attempt settles. |
| **Refund attempted on `pending` / `failed` / `expired` / `needs_support`** | `409 refund_not_allowed`. Parked money is #83. |
| **Refund requested at 23:59 of day 6, settled on day 9** | Settles: the window gates the *decision*, not the provider's latency. Tested. |
| **`commerce_refunds` stuck in `requested`** (provider never answers, learner never retries) | The row holds the one-per-exam slot — deliberately: an unresolved refund is not a free retry. It is the work queue, and an operator can write `requested → failed` (`commerce_refunds_status_transition` allows it) once the provider's state is known. No route, no job, no retention job in B3. |

`docs/commerce.md` §Failure paths gains these rows; the existing row *"A provider event for a `failed` checkout → the transition guard refuses `failed → paid`"* is **now wrong** and must be replaced (§13).

---

## 11. Acceptance criteria

1. `npm run verify` passes, and the full migration chain applies to a fresh local D1 in order, twice (the harness applies it twice). Evidence: the command and its output, plus CI status on the PR head.
2. `0020` creates `commerce_refunds`, `commerce_refund_lines`, their four indexes/triggers, the one-per-exam index, `commerce_checkouts_refunded_requires_settled_refund` and `commerce_receipts_refund_references_settled_refund`; it replaces `commerce_checkouts_status_transition`; no table is rebuilt and no data is copied.
3. The replaced transition trigger accepts: `pending → {paid,failed,expired,needs_support}`, `expired → {paid,needs_support}`, `failed → {paid,needs_support}`, `paid → {refunded,needs_support}`, and same-status no-ops. It rejects everything else, including `refunded → *` and `needs_support → *`. **`expired → needs_support` still works** — asserted explicitly.
4. `paid → refunded` without a settled refund naming that checkout aborts at storage. A refund receipt whose `refund_id` is not a settled refund for that checkout, or whose `total_minor` is not that checkout's refund line amount, aborts.
5. A refund line for a checkout that is not `paid`, not the refund's learner/exam/currency, whose amount is not the checkout's total, or whose `requested_at` is not before its `window_ends_at`, aborts.
6. A second non-`failed` self-serve refund row for the same `(account, exam)` aborts at the partial unique index — including when written by raw SQL, not only as a `409` from the route.
7. `POST …/refund` inside the window settles: exactly one `commerce_refunds` row, one line per checkout, Pro revoked before Standard, one refund receipt per checkout, checkouts `refunded`, `paid_at` unchanged, `200` with the shape of §8.1.
8. `now === paid_at + refundWindowMs` → `400 refund_window_closed`, zero rows written; `now === paid_at + refundWindowMs − 1` settles.
9. Repeating a settled refund's request returns `200` with the identical body and **does not call the provider** (call count stays 1). A `requested` refund's request re-calls the provider with the same `refundId`; a second `refundId` is never minted for one checkout.
10. A Standard purchase that would orphan a separately-bought Pro refunds **both** checkouts in one refund row with two lines, `includedBecause` `requested` / `dependent-pro`, both checkouts `refunded`, both grants revoked, `amountMinor` = sum of the lines.
11. A staff-granted Pro (`source = 'grant'`, no `:pro` checkout operation id) in the way → `409 refund_requires_support`, zero rows changed, provider not called.
12. After a settled refund with no other coverage: `evaluateAccess` is `expired` for both features with `graceEndsAt === null`, `can(access,'results') === false`, and the exam is absent from `GET /api/practice/dashboard`. With an earlier unrefunded purchase, the state is `active` instead — the refund revoked only what it refunded.
13. A later purchase chained on the refunded one → `409 refund_requires_support`, nothing written.
14. `failed → paid`: a `checkout.completed` arriving after `checkout.failed` settles normally (grants, receipt, `paid_at`, `200 {duplicate:false}`); a `checkout.failed` that cannot be applied from `failed` lands in `needs_support` instead of stranding. Both are reachable **only** because the five predicates in §3.5 widened; a test asserts the grant and the park, not just the transition.
15. Every purchase-written grant satisfies `starts_at >= checkout.paid_at` (the lemma's premise), asserted across all seven SKUs.
16. `GET /api/commerce/receipts?certificationId=` returns only the caller's receipts, `issued_at DESC`, `kind` purchase and refund, with `refundId`/`refundWindowEndsAt`/`grantId` null exactly as §8.2 states; `GET /receipts/:id` for another learner is `404`.
17. `receipt_number` matches `^CP\d{8}-[0-9A-F]{12}$` and is unique across the purchase and refund receipt of one checkout, and across two purchases.
18. The receipt row and its JSON carry no key matching `/card|pan|cvv|tax|vat|gst|invoice|email|ip_?address|name/i`; `commerce_receipts`, `commerce_refunds` and `commerce_refund_lines` each reject `UPDATE`/`DELETE` where append-only.
19. The learner's `reason` text does not appear in `audit_events`; each revocation writes one `access_revoked` row whose `operation_id` is `refund:<refundId>:<grantId>`.
20. `GET /checkouts/:id` after a refund: `refundWindowEndsAt === null`, `paidAt` unchanged, `status === "refunded"`.
21. Every refund/receipt route returns `503 commerce_disabled` with `COMMERCE_ENABLED` not `"true"`, `401` without a session, `400 invalid_origin|invalid_csrf` on a mutation.
22. No price or currency constant appears outside `pricing.ts` (the existing grep evidence must still pass), and no commerce source file references a mail transport.
23. `docs/commerce-refunds.md` lands with this design; the §13 doc edits are in the same PR, and every "absent today" claim they remove is true.

---

## 12. Test plan

Files under `apps/api/test/` (vitest, real D1 through `applyD1Migrations`). New factories in `factories.ts`: `createStaffProGrant(database, userId, certId, window)` (`source='grant'`, no `:pro` operation id) and `createPaidCheckout(database, userId, certId, sku, {paidAt})` (a paid checkout with lines and grants written through `planSettlementWindows` and the real operation ids, so refund tests do not re-implement settlement).

### 12.1 `commerce-refund.test.ts` (new)

1. **Happy path, all three refund shapes:** Standard-only; bundle (two grants, one checkout); Pro-only (one grant, Standard untouched, `revoked` has one entry).
2. **Window boundary:** `paid_at + 7d − 1` settles; `paid_at + 7d` → `400 refund_window_closed`, and `SELECT COUNT(*)` on refunds/lines/revocations unchanged.
3. **Access:** the §11 #12 pair (expired-not-grace; earlier-purchase-still-active), plus `can(...)` assertions and the dashboard omission.
4. **Expansion:** the §11 #10 case, asserting `revoked[0].feature === 'pro'` and `revoked[1].feature === 'standard'`, two receipts, both checkouts `refunded`.
5. **Staff-granted Pro:** `409 refund_requires_support`, zero rows, provider call count 0.
6. **Gap guard:** buy 3m, buy 3m again, refund the first → `409 refund_requires_support`; refund the *second* → `200`, state `active` until the first window ends.
7. **Idempotency:** repeat after settle → identical body, provider called once; repeat while `requested` (fake configured to throw) → `202` then a succeeding fake settles the same `refundId`.
8. **Provider `failed` / `rejected`:** no revocation, `503` / `409 refund_rejected`, refund row `failed`, and a follow-up refund attempt **is allowed** (the cap was not consumed).
9. **Not paid:** `409 refund_not_allowed` for `pending`, `failed`, `expired`, `needs_support`.
10. **Authorization:** another learner's checkout → `404`; no session → `401`; wrong Origin / missing CSRF → `400`; both write nothing.

### 12.2 `commerce-refund-guards.test.ts` (new — the tests that prove the guards bite)

Each of these is *direct SQL*, not a route call, because the point is that storage refuses what the route would have prevented:

1. Revoke Standard first while a covered Pro is live → aborts with `revoking this standard grant would leave a pro grant uncovered` (0014).
2. `UPDATE commerce_checkouts SET status='refunded'` with no settled refund → aborts (`commerce_checkouts_refunded_requires_settled_refund`).
3. `INSERT` a refund receipt with a `refund_id` on a `requested` refund → aborts; with a `total_minor` differing from the refund line → aborts (#79).
4. Two self-serve refund rows for one `(account, exam)` → aborts at the partial index. A row with `requested_by_user_id <> user_id` → **accepted** (the staff exemption is real).
5. A refund line naming a `pending` checkout → aborts; naming a checkout whose `total_minor` differs → aborts; with `requested_at >= window_ends_at` → aborts.
6. A second line for a checkout already in a **settled** refund → aborts.
7. `UPDATE commerce_refunds SET status='settled'` from `failed` → aborts; from `requested` to `refunded` (invented state) → aborts; `DELETE` → aborts.
8. `UPDATE commerce_checkouts SET status='refunded'` on an already-`refunded` row → no-op legality is fine, but `refunded → paid` aborts.
9. **Re-assert 0019's edges after 0020**: `expired → needs_support` succeeds, `expired → paid` succeeds, `paid → needs_support` succeeds. A replacement that dropped any of them must fail here.
10. **Stale settle CAS**: call the settle step with a `remainingStandardCount` one too low → 0 rows settled, batch aborted, zero revocations, checkout still `paid`.

### 12.3 `commerce-receipts.test.ts` (new)

Purchase and refund receipts for one checkout: numbers distinct and matching the pattern, `refundId`/`refundWindowEndsAt` null exactly per §8.2, `lines` matching the snapshot, refund `grants` carrying `grantId`; list scoping and ordering; `limit` bounds; owner-only single read; the key-regex schema test of §11 #18; and no mail-transport import in any commerce source file.

### 12.4 `commerce-webhook.test.ts` (extend)

`failed → paid` settles (grants, receipt, one `paid_at`); `failed` + an unappliable completion → `needs_support` with `paid_at` and a single event row (the un-stranding case); `checkout.failed` on a `paid` checkout still writes `ignored-inconsistent` and changes nothing; a completed event on a `refunded` checkout is `ignored-inconsistent` and writes nothing. Re-run the existing suite unchanged otherwise — the five predicate widenings must not alter any existing outcome.

### 12.5 `commerce-checkout.test.ts` (extend)

`refundWindowEndsAt` becomes `null` after a refund (route-level), which is the only behavioural change on the checkout read.

---

## 13. Docs that would otherwise ship a lie (same PR)

| File | Change |
|---|---|
| `docs/commerce.md` | Add "Refunds — `0020_refunds.sql`" (tables, batch order, the lemma in one paragraph, endpoints, failure paths). **Delete** the three bullets under "Arrives in the next commerce change" describing refunds, and the two "Owner decisions … recorded and not implemented here" bullets. **Replace** the Failure-paths row that says `failed → paid` is refused. Rewrite the `commerce_receipts` note that said 0020 must "either rebuild … or enforce it with a trigger" (answered: trigger). Record: `needs_support` adverts a refund window no route honours (#83); receipts read is capped at 50 with no cursor; the fake provider is still local-only. |
| `docs/entitlements.md` | Rewrite the "Refund execution … is the one item still absent" paragraph: `commerce_refunds` exists, `paid → refunded` exists, a refund receipt exists, `refundWindowEndsAt` can now be acted on, and revocation is still terminal (`learner_access_grants_immutable_update`). |
| `docs/open-decisions.md` | Add two open items: (a) a refund that would leave future-but-not-present coverage — currently refused `409 refund_requires_support`; (b) an unresolved `requested` refund holds the one-per-exam slot until an operator resolves it. Keep the two #83 bullets, and note that B3 deliberately does not refund parked money. |
| `packages/contracts/src/commerce.ts` (header comment) | It currently says "Nothing here carries … a receipt or a refund" and "the stored receipt is a database row that no response in this phase returns". Both become false; rewrite the header. |
| `docs/commerce-refunds.md` | This document, committed. |

**No ADR amendment.** ADR 0003 already states the 7-day/no-questions/one-per-exam rule, the calendar-month terms and the dependent-Pro policy. The index refinement in §3.1 is an implementation note, not an ADR rule — recorded here and flagged in §14.

---

## 14. Rulings the brief asked for

**(a) Does the refund free #74's pending slot?** It never held it. `commerce_checkouts_one_open_per_fingerprint` is `WHERE status = 'pending'`, and a refundable checkout is `paid` — so the slot was already free from the moment it settled, and the refund changes nothing about that index. **Can a refunded learner re-buy immediately? Yes**, and that is intended:
- Standard SKUs are always purchasable, so a new checkout is created for the same `(user, certificate, SKU)` with no pending row in the way.
- Pro becomes purchasable again because `proWindowActive` ignores revoked grants (0019's own comment: "A revoked window is not a window: after a refund the learner may buy Pro again"). I **confirm no bar**: the control on buy→refund loops is the one-per-exam cap, not a purchase ban, and a purchase ban would be a new product rule that appears in no source.
- Consequence to record, not to fix: after a refund, a second purchase of the same exam can never be self-serve refunded. That belongs to Phase 5 copy, not to this PR.
- The one place re-buy interacts badly is the *chained* case — a purchase made before the refund, whose window starts after the refunded one — which is owner question 1.

**(b) Is the refund receipt's shape right?** Confirmed against 0019: `refund_id` non-null for `kind='refund'` (CHECK `(kind='refund') = (refund_id IS NOT NULL)`), and `refund_window_ends_at` **must be null** for a refund receipt (CHECK `(kind='purchase') = (refund_window_ends_at IS NOT NULL)` would otherwise abort). `receipt_number` still yields uniqueness across two kinds for one checkout because it is derived from the row's own id plus `issued_at`, not from the checkout: different ids → different numbers, with a residual 2⁻⁴⁸ same-day collision that the `UNIQUE` constraint turns into an aborted batch (retryable) rather than a duplicate document. The one refinement is **one refund receipt per refunded checkout** (§3.3).

**(c) Anything in 0019 that is now wrong.** Five things, four of them documentation:
1. `docs/commerce.md` §Failure paths — "A provider event for a `failed` checkout → the transition guard refuses `failed → paid`" is wrong from 0020 onward.
2. `docs/commerce.md` §"Arrives in the next commerce change" — every refund bullet is now a lie.
3. `docs/commerce.md` §Settlement, receipts — "one purchase receipt per checkout" reads as "only purchase receipts"; and the #79 note ("either rebuild … or enforce with a trigger") is now decided.
4. `docs/entitlements.md` — "refund execution is the only item still absent".
5. **Code, not docs:** five `status IN ('pending','expired')` predicates in `webhooks.ts` are the difference between `failed → paid` being true and being decorative (§3.5). Nothing else in 0019 is wrong: its money/status CHECK *requires* `paid_at` on `refunded`, which is exactly what a refund should do; `commerce_checkouts_immutable` permits `status`/`updated_at` to move while freezing `paid_at`, so a refund cannot rewrite the purchase; `commerce_checkouts_one_open_per_fingerprint` is unaffected; and `learner_access_grants_one_pro_window` already reads `revoked_at IS NULL`, which is what makes re-buy after a refund legal.

---

## 15. Owner decisions required

Everything below is decided as written so DEV can ship; each is listed because it is a rule, not an implementation detail, and one line reverses it.

1. **A refund that would leave a learner with future but not present Standard coverage is refused `409 refund_requires_support`.** Reachable: buy 3 months, buy 3 months again three days later, refund the first. The learner would be locked out *and unable to buy access* until the second window starts, because every Standard purchase appends to the latest end and the top-up/extension SKUs require live coverage. **Recommend: refuse** (nothing moves, access intact, support resolves). If you prefer to grant it and accept the gap, it is one predicate to delete and one test to invert — but then the "you can always buy access" property is false in that window.
2. **The one-per-exam index excludes `failed`**, so a provider decline that moved no money does not consume the learner's one self-serve refund. Deviates from the literal index in the approved design. **Recommend: keep the exclusion**; the settled case remains airtight.
3. **`409 refund_rejected`** for a definitive provider decline, instead of reporting it as `503 provider_unavailable`. Reports the provider; creates no product rule.

Two things I want on the record because they are policy-adjacent and I have made the *technical* call, not the commercial one: **re-buy after a refund is allowed** (the cap, not a ban, is the control — §14a), and **a refunded learner's subsequent purchase can never be self-serve refunded** (a consequence of owner decision 1, whose learner-facing wording is Phase 5).

---

## 16. Uncertainty, stated plainly

- **#82's body is unread** (§1). If it covers anything beyond the refund endpoint and revocation, B3 as specified is short of it.
- **I have not run anything.** Every statement above is read against the shipped migrations and modules, and against `applyD1Migrations`' existing twice-apply property, but the DDL in §3 has not been applied to a real D1 in this session. The two things I would want to see before approving an implementation are (a) the twelve trigger-abort cases in §12.2, each with its exact SQLite message, and (b) `npm run verify` on the PR head with its output, plus CI status.
- **One judgement call I would revisit with evidence:** whether the coverage-gap *refusal* (§15.1) is better than granting the refund and letting the learner re-buy through the bundle (which, being the only SKU whose Standard leg starts at `now`, is the sole route back into a gap). That is a learner-facing consequence I can measure only once there is a UI to measure it on.
- **One thing I deliberately did not design:** whether a refund should also end an in-flight timed mock session. Today the mock's answer trigger refuses a revoked grant, so the attempt simply stops accepting answers. Any "finish the mock you are in" grace would be a product rule (and ADR 0005 defines grace for expiry only), so it stays out and is recorded nowhere but here.

**Verdict:** this design is ready for DEV to implement in one PR. It is **not** an implementation approval — approval requires the §11 #1 evidence plus CI status on the PR head, and I will review the diff, not the report.