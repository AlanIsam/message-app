# Styling — Color Scheme (Forest Dark)

## Direction
Dark theme, built around the green (`#22c55e`) already used by the online badge and
notification color in Phase 3 and Phase 5. The accent, presence indicator, and brand color
all belong to one family, so the app reads as intentional rather than a Discord clone.

Dark-only for v1. No light mode — chat apps skew dark and it halves the styling work.

---

## Palette

| Token | Hex | Use |
|---|---|---|
| `deepest` | `#16191a` | Header bars, deepest surfaces, nav backgrounds |
| `background` | `#1e2321` | Main app / screen background |
| `surface` | `#2a302d` | Cards, incoming message bubbles, input field, modals |
| `accent` | `#16a34a` | Own message bubbles, primary buttons, active states |
| `accentBright` | `#22c55e` | Online badge, notification color, focus highlights |
| `text` | `#e6e9e7` | Primary text |
| `textMuted` | `#8a938e` | Secondary text, placeholders, timestamps |
| `online` | `#22c55e` | Online presence dot (same as accentBright) |
| `offline` | `#8a938e` | Offline presence dot |
| `danger` | `#dc2626` | Destructive actions (leave group, delete) |
| `border` | `#333b37` | Hairline dividers, input borders |

### Notes
- **Two greens on purpose.** `accent` (`#16a34a`, deeper) is for large filled areas like own
  message bubbles and buttons. `accentBright` (`#22c55e`, lighter) is for small indicators —
  the online dot, focus rings. Keeping them distinct stops the online dot from disappearing
  into a green bubble.
- **Text on accent.** Own message bubbles use `accent` fill with white (`#ffffff`) text —
  white reads cleaner than `text` on a saturated green.
- **Online badge stays green** regardless of theme. Green = available is a universal
  convention; don't override it.

---

## Component Mapping

| Component / Screen | Background | Text | Accent element |
|---|---|---|---|
| App background | `background` | `text` | — |
| Chat header | `deepest` | `text` | `online` dot |
| Incoming message bubble | `surface` | `text` | sender name in `textMuted` |
| Own message bubble | `accent` | `#ffffff` | — |
| Message input field | `surface` | `text` (placeholder `textMuted`) | send button `accent` |
| Conversation list item | `background` | `text` | `online` badge, last-msg preview `textMuted` |
| Create-group modal | `surface` | `text` | "Create" button `accent`, selected rows `accentBright` outline |
| Login / register buttons | — | `#ffffff` | button fill `accent` |
| Online badge (Phase 3) | — | — | `online` / `offline` |

---

## Implementation Note
When code generation begins, this palette becomes `constants/colors.ts` — the file
`phase-1-auth-and-chat-ui.md` already references at `constants/colors.ts`. Every phase and
component should import from that single source rather than hardcoding hex values, so the
theme can be adjusted in one place.

Expected shape:

```ts
// constants/colors.ts
export const colors = {
  deepest: '#16191a',
  background: '#1e2321',
  surface: '#2a302d',
  accent: '#16a34a',
  accentBright: '#22c55e',
  text: '#e6e9e7',
  textMuted: '#8a938e',
  online: '#22c55e',
  offline: '#8a938e',
  danger: '#dc2626',
  border: '#333b37',
} as const
```

---

## Out of Scope for v1
- Light mode / theme switching
- Per-user accent customization
- Custom fonts (use the system default for now)
- Animated transitions beyond default navigation

---

## Alternatives Considered (for the record)
- **Blurple (`#5865f2`)** — the literal Discord look. Rejected: too close to a clone, accent
  unrelated to the existing green badge.
- **Midnight teal (`#0d9488`)** — modern, distinct. Rejected: teal sits next to the green
  online badge on the color wheel, risking a muddy teal-on-green presence indicator.
