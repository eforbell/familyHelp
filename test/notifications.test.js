'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAssignedTicketNotificationPayload,
  normalizeBrrrTarget,
  notificationInterruptionLevel
} = require('../lib/notifications');

test('normalizeBrrrTarget accepts raw secret or full URL', () => {
  assert.equal(normalizeBrrrTarget('abc123secret456'), 'https://api.brrr.now/v1/abc123secret456');
  assert.equal(normalizeBrrrTarget('https://example.com/hook'), 'https://example.com/hook');
});

test('notificationInterruptionLevel escalates urgent tickets', () => {
  assert.equal(notificationInterruptionLevel('urgent', 'active'), 'time-sensitive');
  assert.equal(notificationInterruptionLevel('normal', 'passive'), 'passive');
});

test('buildAssignedTicketNotificationPayload includes deep link when provided', () => {
  const payload = buildAssignedTicketNotificationPayload(
    { id: 42, title: 'Wifi keeps dropping downstairs', priority: 'normal', category_name: 'IT/Tech' },
    {
      actorName: 'Eric',
      defaultInterruptionLevel: 'active',
      openUrl: 'https://family.example/help/ticket/42'
    }
  );

  assert.deepEqual(payload, {
    title: 'FamilyHelp: Wifi keeps dropping downstairs',
    subtitle: 'IT/Tech • normal priority',
    message: 'Eric created and assigned a new help ticket to you.',
    open_url: 'https://family.example/help/ticket/42',
    'interruption-level': 'active'
  });
});
