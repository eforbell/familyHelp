# Feature 5: Reminders & Notifications Foundation

## What we're building

FamilyHelp has the right workflow data already, but nothing raises its hand when work goes stale. This feature adds a reminder system that watches assigned tickets, detects when they have been sitting too long, and nudges the assignee.

The first rollout is intentionally narrow:

- Detect stale assigned tickets on the server
- Run that detection from a separate scheduled process
- Deliver reminders through `brrr`
- Optimize for Evan as the primary assignee

This is not the full notification endgame. It is the lowest-friction path to make FamilyHelp materially more useful right now.

## Why this shape

Web push on iPhone is real, but it would force PWA work first: manifest, install flow, service worker or declarative push handling, subscription management, and permissions UX. FamilyHelp does not have any of that yet.

`brrr` fits the immediate need much better:

- HTTP webhook with stored secret
- Native delivery to iPhone/iPad/Mac
- Supports title, message, sound, deep link, and interruption level
- Ideal for one-person-first rollout

The more important architectural decision is splitting "what is stale?" from "how do we deliver a reminder?" Once that boundary exists, `brrr` can be replaced or complemented later by web push, Pushover, or something else.

## Architecture

### Reminder engine

A standalone Node script runs on a schedule via `systemd` timer or cron. It queries PostgreSQL for tickets that are:

- assigned to someone
- still actionable (`open`, `in-progress`, `waiting`)
- idle past a threshold based on priority
- not snoozed
- eligible for another reminder

This process should not depend on incoming web requests and should not be buried in the Express server lifecycle.

### Channel abstraction

Notification sending goes through a small server-side abstraction:

- `brrr` channel first
- future `web_push` channel later

The stale detection code should decide *that* a reminder is needed. The channel layer should decide *how* to send it.

### Reminder state

Store reminder bookkeeping separately from ticket content:

- last reminder time
- next eligible reminder time
- reminder stage / cadence
- snooze until

This prevents duplicate sends and avoids abusing `tickets.updated_at` for reminder bookkeeping.

## Data model

### `member_notification_channels`

Per-member delivery endpoints.

Suggested shape:

- `id`
- `member_id`
- `channel_type` (`brrr` now, others later)
- `label`
- `target_secret` or `channel_payload`
- `enabled`
- `created_at`
- `updated_at`

### `ticket_reminder_state`

Per-ticket reminder bookkeeping.

Suggested shape:

- `ticket_id`
- `last_reminded_at`
- `next_reminder_at`
- `reminder_stage`
- `snooze_until`
- `last_delivery_error` (optional, useful for debugging)

## Reminder rules, v1

Start simple and keep the noise down.

- `urgent`: remind after 4 hours idle, then daily
- `normal`: remind after 24 hours idle, then every 2 days
- `long-term`: remind after 7 days idle, then weekly

Suppression rules:

- no reminders for unassigned tickets
- no reminders for `resolved` or `closed`
- no reminders while snoozed
- global reminders toggle can disable the whole system

## Admin/UI additions

Settings should gain only the controls needed for v1:

- enable/disable reminders
- store Evan's `brrr` webhook
- edit thresholds for urgent/normal/long-term
- choose passive vs active default behavior

Ticket detail can gain minimal reminder controls:

- snooze for a few preset durations
- show reminder state ("next reminder tomorrow morning", "snoozed until ...")

## Delivery behavior

Each reminder should be short and actionable.

Example:

- title: `FamilyHelp: 3 stale tasks`
- message: `Garage shelf ticket has been waiting 2 days`
- open URL: direct link to `/help/ticket/123`

For v1, treat reminders as gentle nudges, not alarms. Reserve louder interruption behavior for urgent tickets only.

## Rollout plan

### Phase 1

- DB tables for channels and reminder state
- `brrr` sender
- standalone reminder runner
- manual webhook entry in settings

### Phase 2

- ticket snooze
- richer per-priority settings
- better message formatting and dedupe

### Later

- standards-based web push for installed Home Screen users
- family-wide onboarding
- digests, badges, game mechanics, escalation paths

## What this does NOT include

- PWA manifest and install flow
- service worker and browser push subscriptions
- kid reward system
- due dates / full task scheduling model
- escalation chains or parent backup notifications
