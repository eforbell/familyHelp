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
psql $DATABASE_URL -f db/schema.sql
psql $DATABASE_URL -f db/seed.sql
```

If upgrading from an earlier version, check `db/migrations/` for any new migrations to run.

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
```

## Deployment (Linux / Tailscale)

The app runs on a home server behind nginx. Designed for LAN/Tailscale access.

### systemd

```bash
sudo cp deploy/family-help.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable family-help
sudo systemctl start family-help
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
```

## Project structure

```
server.js              # Express server, all routes inline
lib/
  date-utils.js        # Date formatting helpers
  openai.js            # MagicHelp AI (generate + follow-up)
db/
  schema.sql           # Full schema (run on fresh installs)
  seed.sql             # Family members, categories, default config
  migrations/          # Incremental schema changes
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
  deploy.sh            # Git-based deploy script
planning/              # Feature plans and progress tracking
```

## Important: nginx subpath compatibility

All fetch() calls use relative paths (`fetch('api/tickets')`, never `fetch('/api/tickets')`). All HTML asset refs are relative. This is required because nginx maps `/help/` to the app root.
