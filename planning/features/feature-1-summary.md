# Feature 1: Core Helpdesk

## What we're building

The foundational helpdesk app -- tickets, family members, views, and assignment. Everything else (AI, skills, attachments) layers on top of this.

## Architecture

Same recipe as familyDinner and familyPlan: Node.js + Express + PostgreSQL + vanilla HTML/CSS/JS. Port 3002, nginx at /help/. Dark theme with a new accent color (green, #4caf50 -- "help is here" energy, distinct from orange/dinner and blue/plan).

## Data model

### family_members
Reusable across apps. Name, role (parent/kid), avatar. Parents are admins by default.

### tickets
The core entity. Every request for help is a ticket.

- **title** -- short summary (required, min 10 chars)
- **description** -- the actual problem (required, min 30 chars -- forces real detail)
- **category** -- IT/tech, chores, homework, house maintenance, errands, other
- **priority** -- urgent (now!), normal, long-term (honey-do list)
- **status** -- open, in-progress, waiting (on requester), resolved, closed
- **created_by** -- who needs help
- **assigned_to** -- who's helping (nullable, can be unassigned)
- **link_url** -- optional reference link
- **ai_suggestion** -- MagicHelp response (nullable, filled in Feature 2)
- **created_at, updated_at, resolved_at**

### ticket_comments
Threaded conversation on each ticket. Who said what, when. This is how the helper asks follow-up questions and the requester provides more info.

### app_config
Key-value settings (AI prompts, categories list, etc.) -- same pattern as other apps.

## Pages & views

### / (Home -- My Dashboard)
- Member picker on first visit (localStorage `fh_member`)
- Two sections: "Tickets I Filed" and "Tickets Assigned to Me"
- Quick-create button
- Badge counts for open items

### /new (Create Ticket)
- Form: title, description (with minimum length enforcement), category dropdown, priority selector, optional link
- Category selection surfaces relevant tips ("For IT issues, describe what you see on screen, what you expected, and what you tried")
- Submit creates ticket as "open" with created_by = current member

### /ticket/:id (Ticket Detail)
- Full ticket info, status badge, assignment
- Comment thread (newest at bottom)
- Add comment form
- Status controls: assign to someone, mark in-progress, resolve, reopen
- Parents can assign any ticket to any member. Kids can only self-assign unassigned tickets.
- Resolution note when closing

### /board (All Tickets -- Admin/Parent View)
- Kanban-ish list grouped by status (open | in-progress | waiting | resolved)
- Filter by assignee, category, priority
- Parents see everything. Kids see only tickets they created or are assigned to.

### /settings (Admin)
- PIN-protected (same pattern as familyPlan)
- Manage categories
- Configure AI prompt for MagicHelp (Feature 2 prep)
- View all members

## API routes

```
GET  /api/members              -- list family members
GET  /api/tickets              -- list tickets (filterable: status, assigned_to, created_by, category, priority)
POST /api/tickets              -- create ticket
GET  /api/tickets/:id          -- single ticket with comments
PUT  /api/tickets/:id          -- update ticket (status, assignment, priority)
GET  /api/tickets/:id/comments -- list comments
POST /api/tickets/:id/comments -- add comment
GET  /api/stats                -- dashboard counts (open, in-progress, resolved this week)
POST /api/settings/unlock      -- PIN auth
GET  /api/config               -- app config (protected)
PUT  /api/config               -- update config (protected)
```

## User stories (Feature 1)

### HELP-001: Member identity and dashboard
- Member picker on first visit
- Dashboard shows "my filed tickets" and "my assigned tickets"
- Badge counts for actionable items

### HELP-002: Create ticket with enforced detail
- Title (min 10 chars), description (min 30 chars), category, priority
- Category-specific guidance prompts
- Optional link field
- Validation feedback before submit

### HELP-003: Ticket detail and comment thread
- View full ticket with metadata
- Add comments (min 10 chars)
- See conversation history

### HELP-004: Assignment and status workflow
- Parents can assign tickets to any family member
- Kids can self-assign unassigned tickets
- Status transitions: open -> in-progress -> waiting/resolved -> closed
- Resolved tickets can be reopened

### HELP-005: Board view with filters
- Grouped by status
- Filter by assignee, category, priority
- Parents see all, kids see own

### HELP-006: Settings with PIN protection
- Reuse familyPlan's PIN auth pattern
- Manage ticket categories
- Placeholder for AI config (Feature 2)

## What this does NOT include (deferred)

- AI MagicHelp (Feature 2)
- Skills/capabilities onboarding (Feature 3)
- Image/screenshot attachments (Feature 4)
- Notifications/alerts
- Due dates and SLAs (might never need this for a household)
