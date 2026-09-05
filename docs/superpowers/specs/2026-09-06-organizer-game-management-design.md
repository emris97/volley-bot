# Organizer Game Management — Design Specification

## 1. Purpose

Complete the currently disconnected organizer experience so that a Telegram
group administrator can create reusable game templates, create and publish a
game, manage it through completion, and continue into attendance and payment
settlement without developer or database access.

The existing domain model, PostgreSQL repositories, durable outbox, BullMQ
scheduler, canonical game message, registration callbacks, attendance flow,
and payment flow remain the foundation. This change adds the missing private
Telegram navigation and application wiring and closes the gaps required for a
safe end-to-end organizer workflow.

## 2. Current State

Production already supports Russian group onboarding. The repository also
contains game/template domain objects, creation and state-change use cases,
registration handlers, scheduled jobs, canonical message refresh, attendance,
and payment settlement.

The organizer cannot currently use those capabilities end to end because:

- `GameCreationHandlers` is not wired into the Telegram runtime;
- there is no organizer-facing list of groups, templates, or games;
- game and template creation have no complete conversational UI;
- the public bot command menu is not configured;
- bare `/start` reports an error instead of opening a main menu;
- `/manage`, `/attendance`, and `/payment` require a game UUID and expose
  implementation details;
- template editing/archival and complete game lifecycle controls are missing;
- publication is not exposed as one retry-safe operation.

## 3. Approved Product Decisions

1. The feature covers the full organizer lifecycle, not only initial game
   publication.
2. Management happens in a private chat with the bot. Group chats contain only
   canonical game cards and participant registration interactions.
3. A group may have multiple reusable templates.
4. A game is created manually from a template. Automatic recurring game
   creation is out of scope.
5. Registration opening follows the selected template. A published card may be
   `SCHEDULED` until registration opens automatically, or `OPEN` immediately
   when the opening time has already arrived.
6. Every current Telegram administrator of the configured group may manage its
   templates and games. Important actions re-check the current Telegram role.
7. The implementation extends the existing architecture instead of replacing
   it with a generic conversation framework or a Telegram Mini App.

## 4. Scope

### 4.1 In scope

- Telegram's system command menu for private chats;
- a Russian main menu for organizers;
- administrator group selection when a user manages more than one group;
- listing upcoming, completed, and cancelled games;
- template creation, editing, copying, and archival;
- persisted, resumable game creation and template editing wizards;
- preview, draft save, retry-safe publication, and optional pinning;
- state-aware game management from `DRAFT` through `COMPLETED` or `CANCELLED`;
- editing game data with optimistic concurrency and scheduler reconciliation;
- participant notification for material schedule/venue changes and
  cancellation;
- recovery when Telegram delivery or canonical-card editing fails;
- Russian validation and expected-error messages;
- complete automated coverage of the organizer journey.

### 4.2 Out of scope

- automatic creation of recurring games;
- Telegram Mini App or any additional frontend;
- assignment of non-administrator `ORGANIZER` roles through Telegram;
- currencies other than `RUB`;
- physical deletion of published games, historical games, or used templates;
- arbitrary time-zone selection beyond the group settings already supported;
- redesign of participant registration, attendance, or settlement business
  rules that are not required to connect the organizer flow.

## 5. Authorization and Group Discovery

The private menu starts from enabled, configured groups for which the sender has
a stored membership of any role, then calls Telegram `getChatMember` and keeps
only `creator` or `administrator` results. It refreshes the stored role from
that authoritative response. Before every mutation, the backend performs the
same live check again.

If Telegram reports that the actor lost administrator rights, the stored
membership is refreshed and the action is denied. Callback payloads never
carry a trusted group ID, role, template snapshot, capacity, price, or state.
They carry only a versioned action and opaque entity identity; ownership and
authorization are resolved server-side.

When one group is available, commands select it automatically. When several
groups are available, the bot presents a group picker and remembers the most
recent selection as a convenience only. Every subsequent action still resolves
and authorizes the entity independently.

An administrator who is not yet known to the bot can press `Управление` on a
group game card. The callback first resolves the game to its Telegram chat,
checks the sender with `getChatMember`, and upserts the user and administrative
membership. If the user has not opened a private chat yet, the callback asks
them to open the bot and press Start; bare `/start` can then discover the newly
linked group. This makes all current Telegram administrators eligible without
requiring the configuring administrator to assign application roles.

An administrator sees a clear empty state if no configured group is available,
with instructions to add and configure the bot in a group.

## 6. Telegram Command Menu

The API registers commands with Telegram `setMyCommands` for the private-chat
scope and removes organizer commands from group-chat scopes. Russian command
descriptions are:

| Command | Description |
| --- | --- |
| `/start` | `Главное меню` |
| `/games` | `Мои игры` |
| `/newgame` | `Создать игру` |
| `/templates` | `Шаблоны игр` |
| `/settings` | `Настройки группы` |
| `/help` | `Помощь` |

Command registration is idempotent and safe on every API start. A transient
Telegram failure is logged and retried without making the webhook API
unavailable.

`/start` dispatch order is exact:

1. a valid signed onboarding token resumes group onboarding;
2. a valid signed guest token resumes guest registration;
3. a non-empty invalid or expired token renders the existing safe token error;
4. a bare `/start` in a private chat opens the main menu;
5. a bare `/start` in a group does not expose organizer controls.

The existing UUID commands `/manage`, `/attendance`, and `/payment` remain
temporarily backward-compatible but are not advertised. New UI paths use
callback buttons and never ask a user to type a game UUID.

## 7. Private Main Menu

The bare `/start` response and the `/games` navigation use inline buttons. The
main menu contains:

- `Создать игру`;
- `Предстоящие игры`;
- `Прошедшие игры`;
- `Шаблоны`;
- `Выбрать группу` when more than one group is available;
- `Настройки группы`;
- `Помощь`.

`/games` opens the games section, `/newgame` starts the creation flow,
`/templates` opens template management, `/settings` opens a summary of current
group defaults, and `/help` explains the organizer and participant flows.

Lists contain eight games per page. Upcoming games are ordered by ascending
start time. Historical and cancelled games are ordered by descending start
time. Each row opens a private management card rather than exposing an
identifier.

## 8. Template Management

### 8.1 Template data

A template continues to use `GameTemplateSnapshot` and contains:

- name;
- venue;
- optional address or map link;
- local start time;
- duration;
- capacity;
- registration opening offset;
- optional registration closing offset;
- tentative confirmation timing and response window;
- participant reminder timing;
- member-priority policy;
- optional default total cost;
- `RUB` currency and rounding rule.

Group settings prefill member priority, tentative timing, reminder timing,
currency, and rounding. They do not overwrite an existing template.

### 8.2 Template wizard

The private wizard displays one concern per step. Inline choices are used for
bounded values; text input is used for names, venue, address, time, capacity,
and cost. Every step offers `Назад` and `Отмена`. Completion requires a preview
and explicit confirmation.

Template drafts are stored in PostgreSQL by group and actor. A process restart,
repeated command, or switching away from the wizard does not lose progress.
Starting again offers `Продолжить` or `Начать заново`.

### 8.3 Template actions

An active template supports:

- `Создать игру`;
- `Изменить`;
- `Копировать`;
- `Архивировать`.

Copying creates a new template draft with a required distinct name. Active
template names are unique within a group after trimming and case folding.
Archiving requires confirmation, removes the template from default selection,
and does not change games that already contain its snapshot. Archived templates
are readable from a separate list and may be restored. Templates are not
physically deleted by this feature.

Concurrent edits use an integer revision. A stale save is rejected with
`Шаблон уже был изменён. Откройте актуальную версию.`

## 9. Game Creation and Publication

### 9.1 Creation wizard

`/newgame` follows this sequence:

1. select a group when necessary;
2. select an active template;
3. enter the game date in the group's local time zone;
4. apply the template's local start time;
5. optionally edit the copied values for this game only;
6. render a complete preview;
7. choose `Опубликовать`, `Сохранить черновик`, or `Изменить`.

The preview includes name, venue/address, local date and time, duration,
capacity, registration opening/closing, confirmation timing, reminder,
priority policy, cost, and rounding. It clearly states whether registration
will open immediately or at a future local time.

Game creation drafts remain in PostgreSQL by group and actor and are resumable.
The draft stores a copy of the selected template values, so later edits to the
template do not change the preview or published game.

### 9.2 Validation

- Names are trimmed and contain 1–80 Unicode code points. Venue values contain
  1–120 code points; optional addresses contain at most 300 code points.
- Date input uses `ДД.ММ.ГГГГ`; local time uses `ЧЧ:ММ`.
- The date/time must resolve unambiguously in the group's IANA time zone and be
  in the future at publication time.
- Duration is an integer from 15 through 720 minutes. Capacity is an integer
  from 1 through 200.
- Monetary input accepts from `0` through `1 000 000` rubles with at most two
  decimal places and is stored as integer kopecks. An explicit `Без стоимости`
  action stores `null`.
- Opening, closing, confirmation, and reminder times must preserve the existing
  database time-order constraints.
- When a closing time is configured, it must still be in the future at
  publication time; the organizer must adjust an already elapsed window before
  publishing.
- Invalid text leaves the user on the same step and shows a Russian correction
  example.

### 9.3 Publication consistency

Publication is an application use case with an idempotency key derived from the
Telegram update and persisted operation identity. In one database transaction
it verifies authorization and draft ownership, creates or reuses exactly one
game, chooses `OPEN` when `registrationOpensAt <= now` and otherwise
`SCHEDULED`, writes audit/outbox events, and marks the draft published.

The existing durable outbox and worker publish or refresh the canonical group
card and reconcile scheduled jobs. Telegram is not called from inside the
database transaction. Retrying after a timeout cannot create a second game or
start a concurrent second card send. Because Telegram `sendMessage` has no
caller-supplied idempotency key, a process crash after Telegram accepts the
message but before its ID is persisted can still leave an orphan duplicate;
the next successful refresh adopts one canonical card and logs the recovery
case for operator cleanup.

When `pinGameMessages` is enabled, the worker attempts to pin the card. A pin
failure does not roll back publication; it is recorded and shown as a warning
in the private result. If a card was deleted or became uneditable, refresh sends
a replacement and atomically adopts its message ID as canonical.

## 10. Canonical Group Card

The group contains a single current card per game. It shows:

- name, venue/address, and local date/time;
- lifecycle and registration status;
- roster count and ordered roster;
- waitlist count and ordered waitlist;
- tentative participants;
- participant buttons appropriate to the current state;
- an organizer `Управление` button that continues privately.

For `OPEN`, participant buttons remain `Иду`, `Не уверен`, and `Добавить
гостя`, with withdrawal presented when applicable. For all other states,
registration mutations are unavailable. Server-side state validation remains
authoritative even if Telegram displays a stale keyboard.

All changes refresh the same card through outbox events. Multiple worker
deliveries converge on one rendering.

## 11. Game Lifecycle Management

The private management card exposes only actions valid for the current state:

| State | Actions |
| --- | --- |
| `DRAFT` | edit, publish, delete the unpublished draft |
| `SCHEDULED` | edit, open registration now, cancel |
| `OPEN` | edit, close registration, cancel |
| `CLOSED` | reopen registration, complete, cancel |
| `COMPLETED` | attendance, settlement, summary |
| `CANCELLED` | view and hide from the active list |

Destructive or externally visible actions require confirmation. Published
games are never physically deleted.

Game editing is state-aware:

- `DRAFT` and `SCHEDULED` permit every snapshot field;
- `OPEN` permits name, venue/address, start, duration, capacity, closing,
  tentative/reminder timing, and cost, but the registration-opening rule and
  priority policy are locked after the first registration;
- `CLOSED` permits name, venue/address, start, duration, capacity, and cost;
- `COMPLETED` and `CANCELLED` are read-only.

Changing a start time must still leave the game in the future. An integer game
revision protects every edit, not only schedule changes. A stale mutation is
rejected with `Игра уже была изменена. Откройте актуальную версию.`

Schedule-affecting changes increment `scheduleRevision`, emit `GAME_UPDATED`,
and cause the worker to remove obsolete jobs and create the exact current set.
Changing capacity runs the existing transactional roster/waitlist rebalance.

Lifecycle transitions remain governed by the domain transition table:

```text
DRAFT -> SCHEDULED -> OPEN -> CLOSED -> COMPLETED
  |          |          |       |
  +----------+----------+-------+-> CANCELLED
                         ^
                         +-- CLOSED may reopen to OPEN
```

Repeated requests that already reached the requested state return the current
result without duplicate audit records or notifications. Invalid transitions
produce a Russian expected-error response rather than HTTP 500.

## 12. Participant Notifications

Ordinary edits such as capacity, cost, or description changes update only the
canonical card.

When one or more active registrations exist:

- changing the date, start time, or venue updates the card and sends one
  private notification to each reachable registered participant;
- cancelling updates the card, removes registration buttons, cancels future
  jobs, and sends one private cancellation notification;
- an unreachable private recipient is recorded without failing the game
  mutation or notifications to other recipients.

Automatic registration opening/closing updates the canonical card without a
separate group message. Existing tentative, reminder, waitlist-promotion, and
payment notification behavior remains unchanged.

Every notification delivery has a deterministic identity derived from its
source outbox event and recipient. Claims prevent concurrent duplicates and a
persisted success prevents later retries. As with the existing notification
flow, delivery is at-least-once across the unavoidable crash window between
Telegram accepting a message and PostgreSQL recording success.

## 13. Group Settings and Help

`/settings` renders the selected group's current time zone, priority policy,
tentative timing, reminder timing, currency/rounding, and pin preference. An
`Изменить настройки` action reuses the Russian onboarding questions in settings
mode. Saving updates group defaults for future template creation only; existing
templates and games retain their snapshots.

`/help` explains:

- how an administrator creates a template and game;
- how participants register or add a guest;
- when registration opens and closes;
- where attendance and payment controls appear;
- that administrative work occurs in private chat.

Help contains no internal UUID-based instructions.

## 14. Persistence Changes

Backward-compatible migrations add:

- `game_templates.archived_at` and `game_templates.revision`;
- a case-folded partial unique index for active template names per group;
- `games.revision` for optimistic concurrency independent of
  `schedule_revision`;
- nullable `games.canonical_pin_failed_at`, cleared after a successful pin, so
  the private management card can surface a non-blocking pin warning;
- `organizer_preferences`, keyed by `user_id`, with nullable
  `selected_group_id ON DELETE SET NULL` for the convenience selection used by
  private menus;
- `template_wizard_drafts`, keyed by `(group_id, actor_user_id)`, with JSON data
  and `updated_at`.

Existing JSON game creation drafts gain a validated versioned payload containing
the wizard step, a generated `draftId`, the copied template snapshot, preview
state, and optional `publishedGameId`; their database primary key remains
`(group_id, actor_user_id)`. Retaining `publishedGameId` until an explicit new
flow begins makes repeated publish clicks converge on the original game.

Material-change and cancellation notices reuse the existing
`notification_deliveries` lease and uniqueness model, keyed by deterministic
outbox job ID and registration. They require no second delivery table.

All schema changes are additive, use explicit constraints and indexes, and are
safe for the existing production migration runner. Historical rows receive
deterministic defaults.

## 15. Error Handling and Recovery

Expected input and authorization failures are mapped to concise Russian
messages and acknowledged to Telegram without returning webhook HTTP 500.

The wizard supports `Назад`, confirmed `Отмена`, resume, and restart. Unknown or
stale callbacks tell the user to reopen the current menu. A missing or archived
template cannot be selected for a new game. A disabled or incompletely
configured group cannot publish.

If Telegram rejects pinning, publication succeeds with a warning. If message
editing reports a deleted/uneditable message, the worker replaces the card. If
Telegram, Redis, or a worker is temporarily unavailable, durable outbox and
reconciliation retry from PostgreSQL state.

Logs use structured error categories and entity IDs needed for operations but
exclude bot tokens, signed start tokens, callback payloads, message text, and
participant personal data.

## 16. Testing Strategy

### 16.1 Unit tests

- command menu definitions and command dispatch precedence;
- Russian presenters and keyboard layouts;
- callback codecs with no embedded trusted data;
- date, time, integer, and monetary parsing;
- wizard transitions, back/cancel/resume behavior;
- lifecycle action availability;
- notification classification for material and ordinary edits.

### 16.2 PostgreSQL integration tests

- group discovery and tenant isolation;
- template create/edit/copy/archive/restore and stale revision rejection;
- game and template draft persistence across handler recreation;
- exactly-one publication for repeated update/idempotency keys;
- concurrent game edit rejection;
- schedule revision and job reconciliation after timing edits;
- capacity-change roster rebalance;
- deterministic participant notification delivery;
- migrations from the current production schema.

### 16.3 Telegram E2E tests

The acceptance journey is:

1. a configured administrator sends bare `/start`;
2. the bot renders the private main menu;
3. the administrator creates and previews a template;
4. the administrator creates a dated game from that template;
5. the game is published once and the group receives one canonical card;
6. registration opens according to the template;
7. participants register, become waitlisted, withdraw, and add a guest;
8. the administrator edits a material field and participants are notified once;
9. registration closes, the game completes, attendance is finalized, and
   settlement is calculated;
10. the completed game appears in history and no command requires a UUID.

Additional E2E cases cover multiple groups, lost admin rights, restart during a
wizard, duplicate Telegram updates, concurrent administrators, card deletion,
pin failure, cancellation, and stale buttons.

### 16.4 Repository-wide verification

The final implementation must pass:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
docker build -f docker/api.Dockerfile .
docker build -f docker/worker.Dockerfile .
```

## 17. Acceptance Criteria

The feature is complete when:

- the private Telegram command menu contains the six approved Russian entries;
- bare `/start` opens the main menu without breaking signed start links;
- a Telegram administrator can manage one or several configured groups;
- multiple reusable templates can be created, changed, copied, archived, and
  restored;
- a game can be created from a template, customized, previewed, saved, resumed,
  and published without duplicate records or cards;
- automatic opening/closing and schedule edits converge after retries;
- the canonical card always reflects current lifecycle and registration state;
- every lifecycle action through completion is available only when valid;
- attendance and payment flows are reachable from the completed game menu;
- material edits and cancellation use deterministic, leased delivery that
  deduplicates successful and concurrent attempts;
- loss of Telegram administrator rights or cross-group identifier tampering is
  denied;
- expected user mistakes do not return webhook HTTP 500;
- existing onboarding, registration, attendance, payment, worker recovery, CI,
  and production CD tests remain green.
