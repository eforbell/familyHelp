#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const { sendBrrrNotification } = require('../lib/notifications');
const {
  ageSummary,
  getReminderConfig,
  nextReminderAt,
  reminderDecision,
  ticketChangedSinceReminder,
  ticketUrl
} = require('../lib/reminder-rules');

const DRY_RUN = process.argv.includes('--dry-run');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getConfigMap() {
  const { rows } = await pool.query('SELECT key, value FROM app_config');
  const config = {};
  for (const row of rows) config[row.key] = row.value;
  return config;
}

function buildNotificationPayload(ticket, reminderConfig, now) {
  const age = ageSummary(ticket.updated_at, now);
  const openUrl = ticketUrl(ticket.id, reminderConfig);
  const stage = Number(ticket.reminder_stage || 0);
  const title = stage > 0 ? `FamilyHelp: still waiting on ${ticket.title}` : `FamilyHelp: ${ticket.title}`;
  const subtitle = `${ticket.assignee_name} • ${ticket.priority} priority`;
  const message = `${ticket.status} and idle for ${age}.`;

  return {
    title,
    subtitle,
    message,
    ...(openUrl ? { open_url: openUrl } : {}),
    'interruption-level': ticket.priority === 'urgent' ? 'time-sensitive' : reminderConfig.interruptionLevel
  };
}

async function markReminderSent(ticket, reminderConfig, now) {
  const changed = ticketChangedSinceReminder(ticket);
  const nextAt = nextReminderAt(ticket, reminderConfig, now);
  const nextStage = changed ? 1 : Number(ticket.reminder_stage || 0) + 1;

  await pool.query(`
    INSERT INTO ticket_reminder_state (
      ticket_id,
      last_reminded_at,
      next_reminder_at,
      reminder_stage,
      snooze_until,
      last_ticket_updated_at,
      last_delivery_error,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NULL, $2)
    ON CONFLICT (ticket_id)
    DO UPDATE SET
      last_reminded_at = EXCLUDED.last_reminded_at,
      next_reminder_at = EXCLUDED.next_reminder_at,
      reminder_stage = EXCLUDED.reminder_stage,
      snooze_until = ticket_reminder_state.snooze_until,
      last_ticket_updated_at = EXCLUDED.last_ticket_updated_at,
      last_delivery_error = NULL,
      updated_at = EXCLUDED.updated_at
  `, [
    ticket.id,
    now.toISOString(),
    nextAt.toISOString(),
    nextStage,
    ticket.snooze_until || null,
    ticket.updated_at
  ]);
}

async function markReminderError(ticketId, err) {
  await pool.query(`
    INSERT INTO ticket_reminder_state (ticket_id, last_delivery_error, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (ticket_id)
    DO UPDATE SET
      last_delivery_error = EXCLUDED.last_delivery_error,
      updated_at = now()
  `, [ticketId, String(err.message || err)]);
}

async function loadCandidateTickets() {
  const { rows } = await pool.query(`
    SELECT
      t.id,
      t.title,
      t.status,
      t.priority,
      t.updated_at,
      t.assigned_to,
      fm.name AS assignee_name,
      mnc.target_secret,
      trs.last_reminded_at,
      trs.next_reminder_at,
      trs.reminder_stage,
      trs.snooze_until,
      trs.last_ticket_updated_at,
      trs.last_delivery_error
    FROM tickets t
    JOIN family_members fm ON fm.id = t.assigned_to
    JOIN member_notification_channels mnc
      ON mnc.member_id = t.assigned_to
     AND mnc.channel_type = 'brrr'
     AND mnc.enabled = TRUE
     AND mnc.target_secret IS NOT NULL
    LEFT JOIN ticket_reminder_state trs ON trs.ticket_id = t.id
    WHERE t.assigned_to IS NOT NULL
      AND t.status IN ('open', 'in-progress', 'waiting')
    ORDER BY t.updated_at ASC
  `);
  return rows;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const config = await getConfigMap();
  if (config.reminders_enabled !== 'true') {
    console.log('Reminders disabled. Nothing to do.');
    return;
  }

  const reminderConfig = getReminderConfig(config);
  const now = new Date();
  const tickets = await loadCandidateTickets();
  let dueCount = 0;
  let sentCount = 0;

  for (const ticket of tickets) {
    const decision = reminderDecision(ticket, reminderConfig, now);
    if (!decision.due) continue;
    dueCount++;

    const payload = buildNotificationPayload(ticket, reminderConfig, now);
    const openUrlNote = payload.open_url ? ` -> ${payload.open_url}` : '';
    console.log(`[due] #${ticket.id} ${ticket.title} (${decision.reason})${openUrlNote}`);

    if (DRY_RUN) continue;

    try {
      await sendBrrrNotification(ticket.target_secret, payload);
      await markReminderSent(ticket, reminderConfig, now);
      sentCount++;
      console.log(`[sent] #${ticket.id} to ${ticket.assignee_name}`);
    } catch (err) {
      await markReminderError(ticket.id, err);
      console.error(`[error] #${ticket.id}: ${err.message}`);
    }
  }

  console.log(DRY_RUN
    ? `Dry run complete. ${dueCount} reminder(s) due.`
    : `Reminder run complete. ${dueCount} due, ${sentCount} sent.`);
}

main()
  .catch(err => {
    console.error('Reminder run failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
