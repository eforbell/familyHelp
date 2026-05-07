# Agent Learnings

## Web UI: iOS Input Auto-Zoom Guard

- iOS Safari/WKWebView auto-zooms focused text-entry controls when their computed font-size is below 16px; keep interactive `input`, `select`, and `textarea` controls at `font-size: 1rem` minimum
- If labels or helper copy need to look smaller, size those text nodes separately instead of shrinking the underlying form control
