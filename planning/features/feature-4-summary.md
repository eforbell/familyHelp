# Feature 4: Attachments & Screenshots

## Concept

For IT issues especially, a screenshot is worth a thousand words. This feature adds file upload to tickets and comments.

## Implementation

- Upload endpoint accepts images (jpg, png, webp, gif) up to 5MB
- Files stored on disk in a `uploads/` directory (no cloud storage needed for a LAN app)
- Each upload gets a UUID filename, original name preserved in DB
- `ticket_attachments` table: id, ticket_id, comment_id (nullable), filename, original_name, mime_type, created_by, created_at
- Ticket creation form gets a drag-and-drop / file picker zone
- Comment form gets an attach button
- Thumbnails displayed inline in ticket detail and comment thread

## Mobile consideration

Phone screenshots and camera photos should work seamlessly. The upload form should accept camera input on mobile browsers (`accept="image/*"` with `capture` attribute option).

## Storage management

- Attachments for resolved tickets older than 90 days can be auto-purged (configurable)
- Settings shows total storage used
