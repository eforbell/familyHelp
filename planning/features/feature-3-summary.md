# Feature 3: Skills & Onboarding Interview

## Concept

Each family member has a profile of "what I can help with." When a ticket is filed, the system can suggest the best person to handle it based on skill match. This also enables parents to formally delegate -- "Jordan, you're good with computers, this one's yours."

## Onboarding flow

When a member first joins (or from settings), they go through a guided interview:

1. **Category walkthrough** -- for each ticket category, rate comfort level (can help / learning / not my thing)
2. **Specific skills** -- within categories, pick specifics:
   - IT: wifi, printers, phone setup, app installs, account recovery
   - Chores: laundry, dishes, yard work, organizing, cooking
   - Homework: math, reading, science, writing
   - House: painting, minor repairs, furniture assembly
3. **Freeform** -- "anything else you're good at?"

## How skills inform the system

- Ticket creation: after filing, system suggests "Jordan knows about wifi issues -- assign to him?"
- Board view: highlight skill-matched members next to unassigned tickets
- Parents can edit anyone's skills from settings
- Skills are stored in a `member_skills` table (member_id, category, skill, comfort_level)

## Admin additions

- Parents can add/edit skills for any member
- New skill categories can be added via settings
- Skill suggestions don't auto-assign -- they recommend. Assignment is still a human decision.
