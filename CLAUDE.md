# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Is

Family HelpDesk for the Forbell household. A ticket-based system where family members can
request help, document problems, and get assigned helpers. Parents are admins. The system
enforces detail in requests (minimum character counts) so problems are well-documented.

Family: Eric (Dad, parent/admin), Alex (Mom, parent/admin, managing cancer treatment),
Jordan (Son, kid), Casey (Daughter, kid, softball player).

## Dev Commands

```bash
npm install            # first time
npm run dev            # node --watch (Node 18+)
npm start              # production

# Database setup (run once on a new Postgres instance)
psql $DATABASE_URL -f db/schema.sql
psql $DATABASE_URL -f db/seed.sql
```

Copy `.env.example` to `.env` and fill in values.

## Architecture

Single-process Node.js/Express. No build step. Vanilla HTML/CSS/JS frontend.

```
server.js              # Express -- all routes inline
lib/
  date-utils.js        # Shared date helpers
db/
  schema.sql           # CREATE TABLE statements
  seed.sql             # Family members, categories, default config
public/
  index.html + app.js  # Dashboard (my tickets, assigned to me)
  new.html + new.js    # Create ticket form
  ticket.html + ticket.js  # Ticket detail + comments (served at /ticket/:id)
  board.html + board.js    # Kanban board view
  settings.html + settings.js  # PIN-protected admin settings
  style.css            # Dark theme, green accent (#4caf50)
  favicon.svg
deploy/
  family-help.service  # systemd unit
planning/              # Feature plans and progress tracking
```

## Key Design Decisions

### Nginx subpath compatible
All fetch() calls use relative paths: `fetch('api/tickets')` -- never `fetch('/api/...')`.
All HTML asset refs are relative. The app runs at its own root on port 3002; nginx maps
`/help/ -> http://127.0.0.1:3002/`. No absolute path assumptions anywhere.

### Ticket detail routing
`/ticket/:id` is a server route that serves `ticket.html`. The JS reads the ticket ID
from the URL path. Asset refs in ticket.html use `../` prefix since it's one level deep.

### Enforced detail
Titles require 10+ characters. Descriptions require 30+ characters. Comments require 10+
characters. Both client-side and server-side validation.

### Role-based visibility
Parents see all tickets. Kids only see tickets they created or are assigned to.
Parents can assign any ticket to anyone. Kids can only self-assign unassigned tickets.

### PIN-protected settings
Same pattern as familyPlan. scrypt-hashed PIN, HMAC-signed session cookie, 8-hour expiry.
Bootstrap from SETTINGS_PIN env var on first run.

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| DATABASE_URL | Yes | -- | PostgreSQL connection |
| PORT | No | 3002 | HTTP port |
| SETTINGS_PIN | No | -- | Bootstrap PIN on first run |
| OPENAI_API_KEY | No | -- | For future MagicHelp feature |
| OPENAI_MODEL | No | gpt-4o-mini | For future MagicHelp feature |

## Data Model

- `family_members` -- Eric, Alex, Jordan, Casey (role: parent/kid)
- `ticket_categories` -- IT/Tech, Homework, Chores, House Maintenance, Errands, Other
- `tickets` -- title, description, category, priority, status, creator, assignee
- `ticket_comments` -- threaded conversation + system-generated audit trail
- `app_config` -- key/value config

## Deployment (Linux / Tailscale)

```bash
npm install --omit=dev
node server.js
# or via systemd (see deploy/family-help.service)
```

nginx example:
```nginx
location /help/ {
    proxy_pass http://127.0.0.1:3002/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
