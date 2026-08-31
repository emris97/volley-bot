# Telegram Volleyball Game Bot — Design Specification

Date: 2026-08-31
Status: approved design

## 1. Purpose

Build a multi-group Telegram bot that replaces free-form `+`, `+/-`, guest names, manually maintained rosters, and manual waitlist reconciliation with a deterministic registration workflow.

The first release must let administrators connect the bot without developer involvement, configure their group, create games from templates or from scratch, collect registrations, manage a priority-aware roster and waitlist, request confirmation from tentative participants, and track payment status after each game.

The backend must support future Telegram Mini App and conventional web administration interfaces without moving business rules out of the backend or rewriting the Telegram bot.

## 2. Scope

### 2.1 MVP capabilities

- Self-service onboarding for Telegram group administrators.
- Multiple independent Telegram groups in one bot installation.
- Group-specific time zone, defaults, roles, and queue policy.
- Reusable game templates and one-off games.
- Scheduled registration opening and manual closing or cancellation.
- Registration through buttons rather than parsing free-form chat messages.
- Separate confirmed roster, waitlist, and tentative list.
- Two automatic priority levels: current group members before guests.
- Manual administrator override of roster ordering.
- Guest registration with a required display name and identified inviter.
- Confirmation requests and expiry for tentative registrations.
- Automatic promotion from waitlist when a roster place becomes available.
- Canonical, automatically updated game message in the group.
- Manual confirmation of actual attendees after the game.
- Automatic per-person calculation from the game's total cost.
- Administrator-controlled payment statuses.
- Audit trail for material administrative and registration changes.
- Personal notifications with a group-mention fallback when private messaging is unavailable.

### 2.2 Explicit non-goals for MVP

- Receiving money or integrating with a payment provider.
- Automatically publishing recurring games without administrator review.
- A finished web admin panel or Telegram Mini App.
- Arbitrary priority categories beyond member and guest.
- Inferring registrations from `+`, `+/-`, reactions, or other free-form messages.
- Kubernetes-specific deployment or provider-specific infrastructure.
- Attendance ratings, sanctions, or automatic blocking for late cancellation or unpaid balances.

## 3. Technology and Repository Shape

The implementation uses TypeScript with the following core stack:

- NestJS for application structure, dependency injection, HTTP endpoints, validation, and lifecycle management.
- grammY for Telegram Bot API integration.
- PostgreSQL as the system of record.
- Redis and BullMQ for delayed and retried background work.
- Docker images for portable deployment.

The repository is structured as a modular monolith:

```text
apps/
  api/          NestJS HTTP API and Telegram webhook
  worker/       BullMQ consumers and outbox dispatcher
  admin-web/    reserved for a future browser admin client
  mini-app/     reserved for a future Telegram Mini App
packages/
  application/  use cases and transaction boundaries
  domain/       entities, policies, state transitions, invariants
  persistence/  PostgreSQL repositories and migrations
  telegram/     grammY adapter, message rendering, callbacks
  contracts/    versioned request/response contracts for future clients
```

`apps/admin-web` and `apps/mini-app` may initially contain only documentation or remain absent until implemented. Their future existence must not require reorganizing the backend.

The API and worker are independently runnable processes built from the same repository. They can initially run on one host and later scale separately.

## 4. Architectural Boundaries

The Telegram integration is an inbound and outbound adapter, not the owner of business rules.

```text
Telegram bot ---+
Mini App -------+--> NestJS application services --> domain --> PostgreSQL
Web admin ------+                                  |
                                                   +--> outbox --> BullMQ --> notifications
```

Rules for module boundaries:

- Domain and application packages must not import grammY or Telegram-specific context types.
- Telegram callbacks, future REST controllers, Mini App requests, and web-admin requests invoke the same application services.
- Authorization is enforced by backend application services, not by hidden buttons or frontend routing.
- PostgreSQL is authoritative for groups, games, registrations, roster placement, attendance, charges, and payment status.
- Redis contains delivery work, not authoritative business state.
- Every group-owned record carries a `groupId`. Repository access must always be tenant-scoped.
- Future external HTTP endpoints are versioned under `/api/v1`.

## 5. Backend Modules

- `TelegramModule`: webhook validation, grammY update dispatch, callback encoding, and message rendering.
- `AuthModule`: Telegram administrator verification, Mini App init-data validation, and future web authentication adapters.
- `GroupsModule`: self-service onboarding, roles, time zone, defaults, and group lifecycle.
- `TemplatesModule`: reusable game definitions and defaults.
- `GamesModule`: game creation, publication, editing, state transitions, and cancellation.
- `RegistrationsModule`: participant and guest registration, queue policy, placement, withdrawal, and promotion.
- `NotificationsModule`: notification policies, schedules, delivery intents, and fallback behavior.
- `AttendanceModule`: final post-game participant confirmation.
- `PaymentsModule`: cost splitting, charges, payment status, and administrator reminders.
- `AuditModule`: immutable records of material actions.
- `OutboxModule`: transactional event persistence and reliable transfer to BullMQ.

Each module exposes application services with explicit inputs and results. Telegram-specific reply text is created only in the Telegram adapter.

## 6. Roles and Authorization

Supported roles are:

- `OWNER`: Telegram group owner; may configure all settings and roles.
- `ADMIN`: verified Telegram group administrator; may configure the group and manage all games.
- `ORGANIZER`: application role granted by an owner or administrator; may create and manage games but not change group ownership or administrator roles.
- `MEMBER`: regular participant.

The bot must be a Telegram group administrator with the minimum permissions necessary to check membership reliably and optionally pin canonical game messages. The backend verifies Telegram administrator status during onboarding and periodically when privileged commands are executed.

Removing the bot from the group disables the group without deleting historical data. Re-adding it allows an administrator to reactivate the same group record.

## 7. Group Onboarding

1. A Telegram administrator adds the bot to a group and grants the required permissions.
2. The bot receives the membership update and creates or reactivates a disabled group record.
3. The bot posts a configuration link that opens a private conversation with a signed, short-lived start parameter.
4. The backend verifies that the user is an administrator of the originating group.
5. A private wizard collects:
   - group time zone;
   - default priority policy;
   - tentative confirmation timing and response window;
   - default game reminder timing;
   - payment currency and rounding rule;
   - whether canonical game messages should be pinned.
6. The administrator creates the first game template or finishes onboarding without one.

Configuration must be resumable. Restarting the bot or repeating the start link must not create duplicate groups or duplicate configuration sessions.

## 8. Game Templates and Games

A `GameTemplate` contains reusable defaults:

- name;
- venue and optional address or map link;
- local start time and duration;
- capacity;
- registration opening offset or local opening time;
- optional registration closing time;
- tentative confirmation time and response window;
- participant reminder time;
- priority policy;
- optional default total game cost;
- currency and rounding mode.

Creating a game from a template copies a snapshot of template values into the game. Later template changes do not alter already created games.

An administrator may also create a game from scratch or change any copied value before publication.

Game states are:

```text
DRAFT -> SCHEDULED -> OPEN -> CLOSED -> COMPLETED
                    |       |         |
                    +-------+---------+-> CANCELLED
```

- `DRAFT`: editable and invisible to participants.
- `SCHEDULED`: published, but registration has not opened.
- `OPEN`: accepts registration changes.
- `CLOSED`: no participant-initiated changes; administrators may still correct the roster.
- `COMPLETED`: attendance and settlement are available.
- `CANCELLED`: terminal state; scheduled notifications are withdrawn.

All timestamps are stored in UTC. Local input and display use the group's IANA time zone. A game retains its time-zone context so historical display remains meaningful.

## 9. Registration Model

A registration represents either a Telegram user or a named guest. A guest registration records the inviting user and may later be linked to a Telegram user without losing history.

Registration states are:

- `TENTATIVE`: interested but not confirmed; does not consume capacity.
- `ROSTERED`: confirmed and inside capacity.
- `WAITLISTED`: confirmed but currently outside capacity.
- `CANCELLED`: withdrawn, expired, or administratively removed.

For each registration, the system stores:

- `groupId` and `gameId`;
- participant identity or required guest display name;
- inviter for guests;
- membership snapshot and computed priority level;
- original creation time;
- confirmation time;
- cancellation time and reason;
- optional administrator ordering override;
- actor responsible for each transition.

An active participant may have only one registration per game. Repeated button presses are idempotent and return the current state.

### 9.1 Participant actions

Before registration:

- `Going` creates a confirmed registration.
- `Not sure` creates a tentative registration.
- `Add guest` opens a private flow and requires a guest name.

After registration, the participant sees `Withdraw`. A waitlisted participant sees `Leave waitlist`, implemented as the same cancellation transition with different presentation text.

There is no generic `Not going` action for a user who has not registered.

### 9.2 Queue ordering

Confirmed registrations are ordered by:

1. explicit administrator override;
2. group member before guest;
3. confirmation timestamp;
4. stable registration identifier as a final tie-breaker.

The first `capacity` registrations are `ROSTERED`; the remainder are `WAITLISTED`. Tentative registrations are displayed separately and never block confirmed participants.

When a roster place opens, the first waitlisted registration is promoted automatically and notified. A waitlisted participant has already confirmed an intention to play, so promotion does not require a second acceptance in MVP.

Administrators may move or remove registrations manually. Every override is audited and the canonical message is refreshed.

### 9.3 Concurrency

Every operation that can change placement executes in a PostgreSQL transaction and locks the target game or an equivalent per-game coordination record. The transaction:

1. validates game state and authorization;
2. applies the registration transition;
3. recalculates deterministic placement;
4. writes audit and outbox events;
5. commits atomically.

This guarantees that concurrent clicks cannot overfill the roster or create duplicates, regardless of the number of API instances.

## 10. Canonical Telegram Message

Each published game has one canonical group message containing:

- venue, date, start time, and duration;
- registration state and capacity;
- current roster and waitlist counts;
- optionally the participant names according to group settings;
- tentative count;
- buttons appropriate to the game state;
- a management entry point for authorized users.

The callback payload contains an opaque versioned action and game identifier. It must not contain trusted authorization or priority data.

After a state change, an outbox event requests message re-rendering. Multiple rapid changes may be coalesced. If Telegram can no longer edit the message, the bot publishes a replacement and atomically updates the stored canonical message identifier.

Different games always use different identifiers, so simultaneous games in one group cannot mix registrations.

## 11. Administrator Game Flow

1. The administrator starts `Create game` in a private conversation.
2. They select a template or choose `Create from scratch`.
3. They set the date and optionally change copied parameters.
4. The bot presents a complete preview.
5. `Publish` creates the scheduled or open game and its canonical group message.

The management screen supports:

- edit details;
- open or close registration;
- change capacity;
- reorder, promote, demote, add, or remove a registration;
- cancel the game;
- complete the game;
- confirm actual attendance;
- calculate charges;
- mark payments and send reminders.

All authorization checks occur in backend services even when the management button is visible to other group members.

## 12. Tentative Confirmation

Each game has a confirmation-request time and response window.

1. At the configured time, each active tentative registration receives `Confirm` and `Withdraw` actions.
2. `Confirm` sets the confirmation timestamp and immediately recalculates roster placement.
3. `Withdraw` cancels the registration.
4. When the response window expires, unanswered tentative registrations are cancelled with reason `CONFIRMATION_EXPIRED`.

If the user has started a private conversation with the bot, the request is sent privately. Otherwise, the bot posts a consolidated group message mentioning affected users. A named guest's notification is routed through the inviter.

## 13. Notifications and Reliable Delivery

Notification types include:

- registration opening;
- tentative confirmation request and expiry;
- waitlist promotion;
- game detail change;
- participant reminder;
- registration closing;
- game cancellation;
- payment reminder initiated by an administrator.

Domain changes and their outbox events are written in the same PostgreSQL transaction. A dispatcher claims unsent outbox rows and places idempotent jobs into BullMQ. Workers send Telegram messages and record delivery outcomes.

Every job has a deterministic identity based on event type and business entity. Retries must not create duplicate user-visible notifications. Terminal delivery failures are retained for inspection.

Changing game timing cancels obsolete scheduled jobs and creates replacements. Cancelling a game invalidates future jobs. A reconciliation task can rebuild all required pending jobs from PostgreSQL after Redis loss.

## 14. Attendance, Cost Splitting, and Payment Tracking

After a game is completed:

1. The administrator starts from the final roster and confirms actual billable participants.
2. They may exclude a rostered participant or add a participant who attended without being in the final roster.
3. The administrator enters or confirms the game's total cost.
4. The bot previews participant count, per-person amount, and any rounding surplus.
5. The administrator finalizes the settlement snapshot.
6. The backend creates one charge per billable participant.

The base calculation is:

```text
per-person amount = total game cost / number of billable participants
```

Supported group-level rounding modes are:

- exact to currency minor units;
- round upward to the next 1 major unit;
- round upward to the next 10 major units;
- round upward to the next 50 major units.

For exact minor-unit calculation, the backend divides the total integer number of minor units by the participant count. Any indivisible remainder is distributed one minor unit at a time in stable attendee order, so the generated charges add up exactly to the game cost.

For an upward-rounding mode, every participant receives the same rounded charge. The UI displays the resulting total collection and surplus. The original total cost, calculation inputs, rounding mode, participant charges, allocation order, and surplus are stored as an immutable settlement snapshot.

Charge statuses are:

- `UNPAID`;
- `PAID`;
- `WAIVED`.

Only authorized administrators and organizers may set payment status. Each change stores actor and timestamp. Participants cannot mark their own charge paid. Administrators see paid and unpaid totals and may explicitly send private reminders. The bot does not automatically publish a public debtor list.

Future payment-provider fields are reserved conceptually but no provider-specific schema or integration is implemented until billing requirements are defined.

## 15. Future Mini App and Web Admin Integration

The future clients use the same application services through versioned HTTP controllers.

For a Telegram Mini App:

- the frontend sends raw `Telegram.WebApp.initData` to the backend;
- the backend validates its signature and freshness before trusting user or chat data;
- `initDataUnsafe` is never accepted as authentication;
- the backend resolves the user's group role for every privileged operation.

For a conventional web admin interface:

- authentication is implemented as an adapter, with Telegram Login/OIDC as a supported direction;
- external identity is mapped to the same internal user record;
- tenant and role checks are identical to Telegram and Mini App checks.

No frontend may implement independent queue, payment, or authorization rules. API contracts are versioned and documented so both interfaces can coexist.

## 16. Security and Privacy

- Telegram webhook requests are validated using the configured secret token.
- Configuration links and private-flow start parameters are signed, scoped, short-lived, and single-purpose.
- Mini App initialization data is validated server-side and checked for freshness.
- All administrator operations verify current permissions.
- All repository methods require tenant scope; cross-group access is denied by default.
- Bot tokens, database credentials, and Redis credentials are supplied through secrets or environment variables and never logged.
- Telegram identifiers are stored as PostgreSQL `BIGINT` values and represented as strings at JavaScript boundaries.
- Only data required for operation is retained. Guest display names and audit data follow a documented retention policy before public launch.
- User-visible errors do not expose stack traces, database details, or Telegram credentials.

## 17. Error Handling and Idempotency

- Duplicate Telegram updates and repeated callbacks return the already committed result.
- Stale buttons report the current game or registration state.
- Closed, completed, and cancelled games reject participant changes with a clear message.
- Telegram rate limits and transient errors use bounded retries with backoff.
- Permanent Telegram failures are recorded and do not roll back committed business state.
- Failure to enqueue an event does not lose it because it remains in the PostgreSQL outbox.
- Graceful shutdown stops accepting new requests, finishes or releases claimed work, and closes database and Redis connections.
- Health endpoints distinguish process liveness from readiness to serve webhook traffic.

## 18. Testing Strategy

### 18.1 Unit tests

- game and registration state transitions;
- member-versus-guest priority;
- manual ordering overrides;
- waitlist promotion;
- tentative confirmation and expiry;
- attendance and charge calculation;
- all rounding modes;
- authorization policy.

### 18.2 Property-based tests

Generate action sequences and assert:

- roster size never exceeds capacity;
- one participant never has multiple active registrations in one game;
- roster and waitlist ordering is deterministic;
- tentative registrations never consume capacity;
- charge totals and reported surplus match the settlement snapshot;
- cancelled games produce no active future notification jobs.

### 18.3 Integration tests

- PostgreSQL transactions and concurrent attempts to take the last place;
- unique constraints and idempotency keys;
- outbox claiming and retry behavior;
- BullMQ duplicate delivery handling;
- migrations against empty and populated databases.

### 18.4 End-to-end tests

- group onboarding and administrator verification;
- template and one-off game creation;
- scheduled opening and canonical message creation;
- participant, guest, withdrawal, and promotion flows;
- tentative confirmation through private and group fallback paths;
- completion, attendance, cost calculation, and payment marking;
- cancelled and stale-button behavior.

Telegram API calls are wrapped behind a testable gateway. Most end-to-end tests use recorded or synthetic updates and a fake gateway; a small separate smoke suite may use a dedicated Telegram test bot.

## 19. Observability

- Structured logs include correlation ID, update ID, group ID, game ID, and job ID where applicable.
- Sensitive values and message contents are excluded or redacted.
- Metrics cover webhook latency and failures, active groups and games, queue depth, job retries, outbox lag, notification failures, and database transaction conflicts.
- Alerts initially cover sustained webhook failure, stuck outbox records, growing failed-job counts, and database unavailability.
- Audit events remain a business record and are not replaced by application logs.

## 20. Deployment Portability

Deployment provider is intentionally unspecified.

- `api` and `worker` are built as portable Docker images.
- Configuration is supplied through environment variables and secrets.
- PostgreSQL and Redis use standard connection URLs.
- Application containers store no durable local state.
- The implementation includes liveness, readiness, and graceful-shutdown behavior.
- Local development may use Docker Compose.
- Production may use a VPS, managed PaaS, managed containers, or Kubernetes without changing domain or application code.

## 21. Acceptance Criteria for MVP

The MVP is acceptable when:

1. An administrator can add the bot to an unconfigured group and finish setup without developer intervention.
2. The same bot can manage at least two groups with fully isolated data and settings.
3. An organizer can publish a game from a template or create one from scratch.
4. Participants can register, register guests, select tentative status, and withdraw without writing free-form registration messages.
5. Concurrent registration for the final place results in exactly one rostered participant and a deterministic waitlist.
6. Group members are prioritized over guests according to the configured two-level policy, with audited administrator overrides.
7. Tentative users are prompted at the configured time and expire if they do not respond.
8. Withdrawal promotes the first eligible waitlisted participant and notifies them.
9. The canonical group message converges to the authoritative PostgreSQL state after rapid or repeated changes.
10. After a game, an administrator can confirm billable participants, enter total cost, preview rounding, finalize charges, and mark payments.
11. Redis loss or duplicate Telegram delivery cannot corrupt game, registration, or payment state.
12. The backend exposes clean application boundaries that a future Mini App or web admin controller can use without duplicating business logic.
