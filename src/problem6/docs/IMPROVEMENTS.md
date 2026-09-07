# Comments for improvement — Scoreboard module

Deliverable 3 of the brief: *"Add additional comments for improvement you may
have in the documentation."*

Three kinds of comment, kept separate because they call for different responses:
improvements worth building (§1–2), things deliberately **not** built and why
(§3), and questions only the product owner can answer (§4).

Priority is value-to-cost, not effort. **P0** items should be scheduled before
the module carries anything valuable.

---

## 1. Improvements to the design as specified

### P0 — Move authority over the action to the server

*The single change that converts requirement 5 from "mitigated" to "solved".*

The specification's central finding is that a client-reported completion cannot
be verified by the server, so [§8](../README.md#8-security) can only raise the
cost of abuse. The fix is architectural: the server determines the outcome
rather than being notified of it.

| Action shape | How the server verifies it |
|---|---|
| Quiz, puzzle, challenge | Client submits its answer; server checks it against stored state it never sent to the client |
| Purchase, transfer | Confirmed against the payment ledger; the browser is not consulted |
| Content contribution | Confirmed by the service that stored the content |
| Timed or physical activity | Confirmed by the device/service that measured it, signed service-to-service |

**Migration path, and the reason the boundary was drawn where it was:** replace
the `actionToken` field with a **completion assertion** signed by the action
service and delivered service-to-service. The ledger, the totals, the read
model, the projector and the live delivery are all unchanged — the only edit is
in the verification step of the gate. This module was specified so that this
upgrade is a swap of one check, not a rewrite. That is deliberate.

**Cost:** depends entirely on the action, which is out of scope here. **Value:**
it is the difference between a leaderboard that can be trusted and one that can
only be watched.

### P1 — Ledger partitioning from day one

At the assumed 10^3 increments/second, `score_events` grows by roughly 17 GB per
day. Monthly range partitioning costs an hour to set up now. Retrofitting it
onto a live multi-hundred-gigabyte table is a maintenance window, a rehearsal,
and a rollback plan.

This is the least visible and most certain problem in the specification: nothing
misbehaves for the first few months, and then vacuum, index maintenance and
retention all become difficult at once.

### P1 — A dedicated non-production key for the action-token HMAC

Obvious, and routinely missed. If staging and production share a key, a leak
from the environment with weaker access controls is a production compromise
(T-14). Separate keys, separate secret-manager paths, and a boot-time assertion
that the production key is not the staging one.

### P2 — Extract the stream tier

Holding 10^5 sockets and serving HTTP requests scale on different axes: one is
bound by memory and network egress, the other by CPU. A dedicated push service —
subscribing to the same Redis channel, holding only connections — decouples
them, and stops an API deploy from disconnecting every viewer.

**Do this at roughly 50,000 concurrent viewers, not before.** Below that it is a
second deployable to build, monitor and page for, in exchange for headroom that
is not yet needed.

### P2 — Event sourcing for the score, not just an audit ledger

`score_events` is already an event log. Promoting it to the *only* source of
truth, with `user_scores` demoted to a pure projection, buys: point-in-time
rebuilds, exact fraud reversal, historical rank queries ("who was in the top 10
last Tuesday?"), and seasons as an additional projection rather than a schema
change. The cost is a heavier read for a user's own total, and a genuinely
harder mental model for the team.

Worth doing **if** leaderboard history becomes a product requirement. Not worth
doing for its own sake.

### P2 — Seasons, decay, or both

An all-time board becomes a monument. Once the top 10 stops changing, the *live*
requirement has nothing left to deliver and the feature quietly dies. Weekly or
monthly boards, or a time-decayed score, keep it worth looking at.

The design already anticipates this: `scoreboard:{scope}` in §6.3 and the ledger
in §6.1 make an additional board a new projection over existing data, with no
change to the write path.

### P3 — Smaller items

| Item | Why |
|------|-----|
| `GET /scoreboard/top?around=me` | The client renders the board *and* the user's neighbourhood in one request instead of two |
| Approximate rank for the long tail | `ZREVRANK` is exact and O(log N); at 10^7 users, "top 5%" is cheaper and is what the user actually wants to read |
| Contract tests generated from `openapi.yaml` | Stops the specification and the implementation drifting apart silently — the same discipline that ties Problems 4 and 5's documented edge cases to test ids |
| Chaos testing in CI | §9 lists twelve failure modes; a scheduled job that kills Redis, the projector, and PostgreSQL in turn against staging is how they stay true after six months of changes |
| Rotating opaque ids in public responses | The board otherwise doubles as a user-enumeration endpoint |
| A "score explained" endpoint for support | Reads the ledger and answers "why do I have this score?" without a database session |

---

## 2. Improvements to the requirements themselves

Comments on the brief, offered because the team implementing this will hit them
in week one.

### The board will be boring within a month

Ten all-time leaders, on any product with sustained usage, converge to ten
accounts that do not change. At that point live updates deliver nothing, because
nothing moves. Every leaderboard product solves this the same way — seasons,
periodic resets, decay, or multiple boards — and it is much cheaper to design in
now (P2 above) than to retrofit once users have an all-time rank they feel they
own.

### "Top 10" is the wrong unit for engagement

A user ranked 4,000th sees ten strangers and learns nothing actionable. Their
own rank and the two or three people immediately around them is the information
that changes behaviour. `GET /scoreboard/me` is specified for that reason, and
it is worth stating explicitly that it is likely to matter more to the product
than the top 10 does.

### "Live" needs a defined tolerance

Requirement 2 says live. The specification budgets **under one second** end to
end (§10.1) and throttles broadcasts to at most one per second (§7.3), because
"as fast as possible" is not a specification and cannot be tested or held to.
If the product needs sub-100 ms — a live competitive event, say — that is a
different fan-out design and needs to be known before phase 3, not after.

### The action's value should be configurable without a deploy

`ActionCatalogue` is specified as loaded at boot. Product will want to change
point values during promotions. Making the catalogue a versioned database table
with an admin-only write path — the version already recorded on every ledger row
— is a small addition that avoids a deploy per campaign, and keeps history
explicable after a change.

---

## 3. Deliberate non-goals

Recorded so a reviewer can distinguish a decision from an omission.

| Not built | Why not |
|-----------|---------|
| **CAPTCHA on the increment path** | Continuous friction for every honest user, to inconvenience an attacker once. Reserved as a *targeted* response for accounts already flagged by §8.5, where the cost falls on the right party |
| **Proof-of-work** | Burns the honest user's battery; an attacker with a server has more compute than a phone |
| **Device fingerprinting** | High privacy and regulatory cost, low evasion cost. Weak signal, expensive consent story |
| **Client-side request signing** | Security theatre. Nothing on the client can keep a secret from the person operating the client |
| **Blockchain / signed score chains** | The threat is a legitimate user abusing a legitimate endpoint. Tamper-evident storage does not address it; an append-only table with audited access already provides the integrity property actually needed |
| **Strong consistency between the write and the board** | Costs a synchronous cross-store write on every increment, to remove a sub-second staleness window no user can perceive |
| **A full ranking / paging API** | The requirement is a top 10. An endpoint that will page through a million ranked users is a load generator with a friendly name |
| **Automatic banning on anomaly detection** | A false positive that silently deletes a legitimate user's score destroys trust in the product; a true positive that waits an hour for review costs one leaderboard place for an hour. Flag; let a human decide |
| **WebSocket** | Full duplex the module never uses, at the cost of a second protocol stack to secure, observe and balance ([ADR-002](DECISIONS.md#adr-002-sse-rather-than-websocket-or-polling)) |
| **Multi-region active-active** | Not requested, and it changes the ranking problem fundamentally — cross-region ordering needs either a consensus store or a single write region. Worth a separate design if it is ever asked for |

---

## 4. Open questions for the product owner

Each has a default the team may implement against, so **none of these blocks a
start**. Each also has a consequence if the default is wrong, which is the part
worth reading.

| # | Question | Default assumed | If the default is wrong |
|---|----------|-----------------|-------------------------|
| Q1 | Is the board public, or only for signed-in users? | **Public** (A1) | Stream auth changes — [ADR-010](DECISIONS.md#adr-010-stream-authentication-if-the-board-becomes-private) pre-decides it. Roughly two days |
| Q2 | Can scores decrease, be reset, or expire? | **Monotonic increase** (A2) | The ledger supports it; the `CHECK (total_score >= 0)` and the packed-score tie-break both need revisiting |
| Q3 | How are ties broken? | **Earliest to reach the score** (A3) | Affects the ZSET encoding (§6.4). Cheap to change before launch, a rebuild afterwards |
| Q4 | What is the realistic maximum score per user? | **< 8.4 M** (§6.4 cap) | Re-split the 53 bits and rebuild. **Ask this before launch** — the failure mode is silent rank corruption |
| Q5 | Expected concurrent viewers at peak? | **10^4–10^5** (A4) | Above ~10^5, extract the stream tier (§1, P2) or move to the CDN path |
| Q6 | Does anything of value depend on rank — prizes, money, status? | **No** | If yes, P0 becomes a blocker rather than a recommendation, and this must be settled before launch |
| Q7 | How many action types, and are their point values stable? | **Few, stable, boot-loaded** | A database-backed catalogue (§2) instead of a config file |
| Q8 | Retention period for the ledger? | **Indefinite, partitioned monthly** | Drives partitioning and the archival job |
| Q9 | Must users be able to opt out of the public board? | **Yes** (A5, `is_visible`) | Already specified; confirm it is required, since it costs nothing to keep |

**Q4 and Q6 are the two worth chasing before implementation starts.** Q4 has a
silent failure mode that only appears once a real user crosses the cap, and Q6
determines whether the residual risk in
[`THREAT_MODEL.md` §6](THREAT_MODEL.md#6-the-residual-risk-stated-once-plainly)
is acceptable or disqualifying.
