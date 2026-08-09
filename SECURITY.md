# Security Policy

## Scope and intended deployment

familyHelp stores household support requests, comments, attachments, role labels, and optional AI-generated responses. It is intended for a home server behind nginx and Tailscale or an equivalent private network. Do not expose it directly to the public internet without adding and reviewing full application authentication and attachment authorization.

## Sensitive data and trust boundaries

- Tickets may contain children's homework, device details, error messages, and other private household context.
- Attachments can contain screenshots, photos, or documents. `/uploads/*` is currently served statically without member/PIN/session authorization, so anyone who can reach the service and obtain a URL may fetch a file. Treat the upload directory and backups as sensitive and rely on strict network/proxy access until authenticated downloads exist.
- The Settings PIN protects administrative settings; it is not whole-application authentication.
- Member selection and role-based views are household workflow controls, not a strong identity boundary against a malicious user who can reach the service.
- AI-eligible ticket content and follow-ups are sent to the configured OpenAI service. Notification content may be sent to a brrr secret or any configured full HTTP(S) webhook URL; treat that destination as an external data processor.

## Required operating practices

1. Restrict network access to the trusted household LAN/Tailnet and use HTTPS at the reverse proxy.
2. Set a non-default Settings PIN and protect PIN/session secrets. Do not use the sample value from `.env.example` in production.
3. Keep `DATABASE_URL`, `OPENAI_API_KEY`, notification credentials, and runtime `.env` files out of git.
4. Run the service as an unprivileged account. Restrict database and upload-directory permissions to that account.
5. Current upload checks trust multipart `Content-Type` and preserve a client-derived extension. Preserve size/type checks, add extension allowlisting/content sniffing where possible, serve downloads with `X-Content-Type-Options: nosniff` or forced-download semantics, and never execute or pass attachments to shell commands.
6. Avoid placing passwords, recovery codes, private keys, or unnecessary personal data in tickets or AI prompts.
7. Back up the database and attachment directory together, encrypt off-host backups, and test restores.
8. Review logs and notification payloads for accidental ticket or credential disclosure.

## Secret or data exposure

Rotate exposed credentials immediately, invalidate affected sessions, restrict any exposed attachment, and review access logs. Remove secrets from code and history only after rotation.

## Reporting a vulnerability

Report vulnerabilities privately through a GitHub Security Advisory when available, or contact the repository owner privately. Do not include live credentials, tickets, or family attachments in a public issue. Include affected routes/files, reproduction steps, impact, and a redacted proof of concept.

There is no bug bounty program or guaranteed response SLA.
