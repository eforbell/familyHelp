'use strict';

const PRIORITY_KEY = {
  urgent: 'urgent',
  normal: 'normal',
  'long-term': 'long_term'
};

function parseHours(value, fallback) {
  const hours = Number(value);
  return Number.isFinite(hours) && hours > 0 ? hours : fallback;
}

function getReminderConfig(config) {
  return {
    baseUrl: String(config.reminder_base_url || process.env.FAMILY_HELP_BASE_URL || '').trim(),
    interruptionLevel: String(config.reminder_brrr_interruption_level || 'active').trim() || 'active',
    thresholdsHours: {
      urgent: parseHours(config.reminder_threshold_hours_urgent, 4),
      normal: parseHours(config.reminder_threshold_hours_normal, 24),
      'long-term': parseHours(config.reminder_threshold_hours_long_term, 168)
    },
    repeatHours: {
      urgent: parseHours(config.reminder_repeat_hours_urgent, 24),
      normal: parseHours(config.reminder_repeat_hours_normal, 48),
      'long-term': parseHours(config.reminder_repeat_hours_long_term, 168)
    }
  };
}

function thresholdMs(priority, reminderConfig) {
  return reminderConfig.thresholdsHours[priority] * 60 * 60 * 1000;
}

function repeatMs(priority, reminderConfig) {
  return reminderConfig.repeatHours[priority] * 60 * 60 * 1000;
}

function ageSummary(updatedAtIso, now = new Date()) {
  const diffMs = now.getTime() - new Date(updatedAtIso).getTime();
  const hours = Math.max(1, Math.floor(diffMs / (60 * 60 * 1000)));
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.max(1, Math.floor(hours / 24));
  return `${days} day${days === 1 ? '' : 's'}`;
}

function ticketChangedSinceReminder(ticket) {
  if (!ticket.last_ticket_updated_at) return true;
  return new Date(ticket.last_ticket_updated_at).getTime() < new Date(ticket.updated_at).getTime();
}

function reminderDecision(ticket, reminderConfig, now = new Date()) {
  const staleAt = new Date(new Date(ticket.updated_at).getTime() + thresholdMs(ticket.priority, reminderConfig));
  if (now < staleAt) return { due: false, reason: 'not-stale-yet', staleAt };

  if (ticket.snooze_until && new Date(ticket.snooze_until) > now) {
    return { due: false, reason: 'snoozed', staleAt };
  }

  const changed = ticketChangedSinceReminder(ticket);
  if (changed) {
    return { due: true, reason: 'ticket-updated-since-last-reminder', staleAt };
  }

  if (!ticket.next_reminder_at) {
    return { due: true, reason: 'never-reminded', staleAt };
  }

  const nextReminderAt = new Date(ticket.next_reminder_at);
  if (now < nextReminderAt) {
    return { due: false, reason: 'waiting-for-next-reminder', staleAt, nextReminderAt };
  }

  return { due: true, reason: 'repeat-reminder-due', staleAt, nextReminderAt };
}

function nextReminderAt(ticket, reminderConfig, now = new Date()) {
  return new Date(now.getTime() + repeatMs(ticket.priority, reminderConfig));
}

function ticketUrl(ticketId, reminderConfig) {
  const base = String(reminderConfig.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/ticket/${ticketId}`;
}

function priorityLabel(priority) {
  return PRIORITY_KEY[priority] || 'normal';
}

module.exports = {
  ageSummary,
  getReminderConfig,
  nextReminderAt,
  priorityLabel,
  reminderDecision,
  ticketChangedSinceReminder,
  ticketUrl
};
