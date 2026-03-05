# Feature 2: MagicHelp -- AI First-Tier Support

## Concept

When someone files a ticket, MagicHelp analyzes the problem and attempts a first-tier response before a human even looks at it. This is especially powerful for:

- **IT/tech issues** -- "My wifi keeps dropping" -> troubleshooting steps
- **Homework help** -- "I don't understand quadratic equations" -> clear explanation with examples (not answers, teaching)
- **How-to questions** -- "How do I get a stain out of a white shirt?" -> practical steps

## How it works

1. User submits a ticket
2. If the category is eligible for AI help (configurable), MagicHelp runs automatically
3. AI reads the title + description + category, generates a helpful response
4. Response is stored in `tickets.ai_suggestion` and displayed prominently on the ticket
5. Requester can mark "This helped!" (resolves ticket) or "I still need help" (stays open for human assignment)

## AI guardrails

- **Homework mode**: Explain concepts, don't give answers. Teaching, not cheating.
- **IT mode**: Troubleshooting steps. "Try this first, then this."
- **Safety**: Never suggest anything dangerous. Electrical, plumbing, structural = "Ask a parent or professional."
- Household prompt in app_config is fully tunable by parents via settings.

## Model choice

Use a capable reasoning model (configurable via OPENAI_MODEL env var). Default gpt-4o-mini for cost, but parents can upgrade to gpt-4o or o1-mini for harder problems. The per-ticket cost at gpt-4o-mini rates is fractions of a cent.

## Schema additions

- `tickets.ai_suggestion` TEXT -- the AI response
- `tickets.ai_helped` BOOLEAN -- did the user say it helped?
- `app_config` keys: `magic_help_prompt`, `magic_help_enabled`, `magic_help_categories`
