#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEFAULT_STALE_DAYS = 30;

async function getConfigMap() {
  const { rows } = await pool.query('SELECT key, value FROM app_config');
  const config = {};
  for (const row of rows) config[row.key] = row.value;
  return config;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const config = await getConfigMap();
  const staleDays = Number(config.sweep_resolved_days) || DEFAULT_STALE_DAYS;

  const { rows: stale } = await pool.query(`
    SELECT id, title, resolved_at
    FROM tickets
    WHERE status = 'resolved'
      AND resolved_at < now() - make_interval(days => $1)
    ORDER BY resolved_at ASC
  `, [staleDays]);

  if (!stale.length) {
    console.log(`No resolved tickets older than ${staleDays} days. Nothing to sweep.`);
    return;
  }

  console.log(`Found ${stale.length} resolved ticket(s) stale for ${staleDays}+ days.`);

  let closedCount = 0;
  for (const ticket of stale) {
    console.log(`[stale] #${ticket.id} ${ticket.title} (resolved ${ticket.resolved_at})`);
    if (DRY_RUN) continue;

    await pool.query(
      `UPDATE tickets SET status = 'closed', updated_at = now() WHERE id = $1`,
      [ticket.id]
    );
    await pool.query(
      `INSERT INTO ticket_comments (ticket_id, body, is_system) VALUES ($1, $2, TRUE)`,
      [ticket.id, `Auto-closed: resolved for ${staleDays}+ days with no further activity.`]
    );
    closedCount++;
    console.log(`[closed] #${ticket.id}`);
  }

  console.log(DRY_RUN
    ? `Dry run complete. ${stale.length} ticket(s) would be closed.`
    : `Sweep complete. ${closedCount} ticket(s) closed.`);
}

main()
  .catch(err => {
    console.error('Sweep failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
