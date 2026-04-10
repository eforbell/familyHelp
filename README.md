# familyHelp

**HelpDesk for my home.** A ticket-based system where family members request help, document problems, attach screenshots, and get AI-powered first-tier support. Parents assign and delegate. Everyone pitches in.

Built for the Forbell household. Runs on a home Ubuntu server behind Tailscale + nginx.

## What it does

### Tickets with enforced detail
No more "my computer is broken" with zero context. Titles need 10+ characters, descriptions need 30+. Category-specific guidance prompts coach the requester to give useful info.

### MagicHelp AI (first-tier support)
When a ticket is filed in an AI-eligible category (IT/Tech, Homework by default), OpenAI automatically analyzes the problem and responds with troubleshooting steps, concept explanations, or practical advice.

- **IT issues** get numbered troubleshooting steps
- **Homework** gets teaching, not answers -- explains the concept, gives hints, guides toward the solution
- **Follow-up conversation** -- if the first response isn't enough, ask a follow-up and the AI refines with full context
- **Feedback loop** -- "Yes, resolved!" auto-closes the ticket; "I still need help" keeps it open for a human
- Fully tunable household prompt in Settings

### Image attachments
Drag-and-drop or browse to attach screenshots, photos, or any image (JPG, PNG, WebP, GIF up to 10MB). Thumbnail grid on the ticket, click to open full size. Mobile camera photos work via the file picker.

### Role-based views
- **Parents** see all tickets, can assign to anyone, manage settings
- **Kids** see tickets they created or are assigned to, can self-assign unassigned tickets

### Board view
Kanban-style columns (Open, In Progress, Waiting, Resolved) with filters by assignee, category, and priority.

### Assignment and status workflow
Tickets flow through: open -> in-progress -> waiting -> resolved -> closed (reopenable at any point). Every status change and assignment is logged as a system comment for full audit trail.

### PIN-protected settings
Parents manage categories, toggle AI eligibility, edit the MagicHelp prompt, and view family members behind a PIN lock.

## Tech stack

- Node.js + Express
- PostgreSQL
- Vanilla HTML/CSS/JS (no build step, no frameworks)
- OpenAI via native fetch() with structured JSON schema mode
- Dark theme, green accent (#4caf50)

## Setup

### Prerequisites
- Node.js 18+
- PostgreSQL

### Install

```bash
git clone git@github.com:eforbell/familyHelp.git
cd familyHelp
npm install
cp .env.example .env
# Edit .env with your database URL, optional OpenAI key, and settings PIN
```

### Database

```bash
npm run db:migrate
```

Fresh installs should use `npm run db:migrate` as the primary schema path, then complete the
browser setup flow to create household members, optional Settings PIN, and starter categories.
[db/schema.sql](/Volumes/DATA/workspace/homeApps/familyHelp/db/schema.sql) remains as a
latest-schema snapshot/reference file. [db/seed.sql](/Volumes/DATA/workspace/homeApps/familyHelp/db/seed.sql)
is legacy/dev starter data and should not be required for normal production bootstrap.
Deploys run migrations automatically via [deploy/deploy.sh](/Volumes/DATA/workspace/homeApps/familyHelp/deploy/deploy.sh).

For local dev, a Docker Compose Postgres is included on port `5434`:

```bash
docker compose up -d
cp .env.example .env
npm run db:migrate
npm start
```

### Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | Yes | -- | PostgreSQL connection string |
| `PORT` | No | 3002 | HTTP port |
| `SETTINGS_PIN` | No | -- | Bootstrap admin PIN on first run |
| `OPENAI_API_KEY` | No | -- | Enables MagicHelp AI |
| `OPENAI_MODEL` | No | gpt-4o-mini | Any OpenAI chat model |

### Run

```bash
npm start          # production
npm run dev        # development (auto-restart on changes)
npm run db:migrate # apply numbered SQL migrations
npm run reminders:run
npm run reminders:dry-run
```

## Deployment (Linux / Tailscale)

The app runs on a home server behind nginx. Designed for LAN/Tailscale access.

### systemd

```bash
sudo cp deploy/family-help.service /etc/systemd/system/
sudo cp deploy/family-help-reminders.service /etc/systemd/system/
sudo cp deploy/family-help-reminders.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable family-help
sudo systemctl start family-help
sudo systemctl enable family-help-reminders.timer
sudo systemctl start family-help-reminders.timer
```

### nginx

Add to your nginx config alongside the other family apps:

```nginx
location /help/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 12M;
}
```

Then `sudo nginx -t && sudo systemctl reload nginx`.

### Deploy script

```bash
./deploy/deploy.sh                    # deploy origin/main
./deploy/deploy.sh origin/my-branch   # test a branch in production
./deploy/deploy.sh --restore-stash    # restore last auto-stashed local changes
```

Deploy behavior notes:
- auto-stashes a dirty deploy checkout by default
- set `AUTO_STASH=0` if you want deploys to fail instead
- use `FORCE_DEPLOY=1` only when you intentionally want to bypass the safety check

### Erebor Rollout

```bash
git push origin main
ssh erebor
cd /data/apps/familyHelp
./deploy/deploy.sh
sudo systemctl enable family-help-reminders.timer
sudo systemctl start family-help-reminders.timer
sudo systemctl status family-help --no-pager
sudo systemctl status family-help-reminders.timer --no-pager
```

After deploy, open Settings once to confirm:

- reminders are enabled globally
- your brrr target is still enabled
- `reminder_base_url` points at the erebor/Tailscale URL

## Project structure

```
server.js              # Express server, all routes inline
lib/
  date-utils.js        # Date formatting helpers
  openai.js            # MagicHelp AI (generate + follow-up)
  notifications.js     # brrr delivery helper
  reminder-rules.js    # Staleness and cadence rules
db/
  schema.sql           # Latest schema snapshot / reference
  seed.sql             # Family members, categories, default config
  migrations/          # Numbered SQL migrations (primary schema path)
  migrate.js           # Migration runner (schema_migrations)
scripts/
  send-reminders.js    # Standalone reminder runner
public/
  index.html + app.js      # Dashboard
  new.html + new.js        # Create ticket
  ticket.html + ticket.js  # Ticket detail + comments + attachments
  board.html + board.js    # Kanban board
  settings.html + settings.js  # Admin settings (PIN-protected)
  style.css                # Dark theme
uploads/               # Attachment storage (auto-created, gitignored)
deploy/
  family-help.service  # systemd unit
  family-help-reminders.service  # systemd oneshot reminder runner
  family-help-reminders.timer    # 30-minute reminder schedule
  deploy.sh            # Git-based deploy script
planning/              # Feature plans and progress tracking
```

## Important: nginx subpath compatibility

All fetch() calls use relative paths (`fetch('api/tickets')`, never `fetch('/api/tickets')`). All HTML asset refs are relative. This is required because nginx maps `/help/` to the app root.
