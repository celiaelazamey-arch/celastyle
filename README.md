# CelaStyle

A design system for command-center interfaces — dense, multi-panel workspaces where an
operator has to read a lot of state at a glance and act on it quickly.

The visual identity is a **Graphite** substrate (a cool, heavily desaturated neutral ramp)
punctuated by a single **Lime** signal color. On a screen full of Graphite, Lime is the
only chroma allowed, which is what makes the active panel and the live feed readable from
across a room.

```
celastyle/
├── packages/
│   ├── tokens/   @celastyle/tokens    design tokens — framework-agnostic CSS
│   └── ui/       @celastyle/ui        core components — React
└── apps/
    └── command-center/  @celastyle/command-center   reference application
```

## Why this order

`@celastyle/tokens` contains no React and no framework references — it is plain CSS custom
properties. Components are written against the *semantic* layer (`--surface-raised`,
`--text-primary`, `--accent`), never against the raw ramps (`--graphite-900`, `--lime-400`).

That separation is the point: the token layer can be consumed by React, Svelte, or plain
HTML without modification, and re-theming never requires touching a component. Switching
`data-theme` on `<html>` re-themes the entire system, including every Tailwind utility, at
once.

## Token architecture

| Layer | Files | Purpose |
| --- | --- | --- |
| **Primitives** | `graphite.css`, `lime.css`, `status.css` | Raw ramps. For charts and prototyping. |
| **Foundations** | `typography`, `spacing`, `radius`, `elevation`, `motion`, `layers` | Scales — the design decisions made explicit. |
| **Themes** | `dark.css`, `light.css` | The semantic mapping. **This is what components consume.** |
| **Base** | `base.css`, `utilities.css` | Document defaults and cross-cutting patterns. |

Dark is the default rather than an alternate: a command center is watched for long stretches,
often on a wall or in a dim room.

Two details worth knowing:

- **Lime is not the same value in both themes.** On dark it is `lime-400`; on white, `lime-400`
  at 11px fails contrast, so the light theme drops to `lime-600`. The raw ramp value differs
  per theme while the *role* (`--accent`) does not. This is the entire reason the semantic
  layer exists.
- **Elevation is carried by surface lightness and borders, not shadow.** A shadow on a
  near-black canvas is nearly invisible. Shadows are reserved for things that genuinely float
  — popovers, modals, dragged cards.

## Components

### Command Rail

The primary navigation spine of the workspace. Implemented as a WAI-ARIA **tablist** with
vertical orientation, because that is what it is: a set of peer panels, exactly one of which
is showing. A `nav`/`link` model would be wrong — selecting an item swaps the panel in place,
it does not navigate away.

- Roving tabindex: the whole rail is a single tab stop; arrow keys move between items
- `Home` / `End` jump to the ends; arrow wrapping is supported
- Icon mode keeps labels in the DOM as the accessible name and reveals them as a tooltip on
  hover **and focus** — otherwise the rail is unusable without a mouse

### Compact Card

The dense row for messages, events and item summaries. Tuned to survive being stacked 40 deep
in a panel: quiet surface, separator as a border rather than a shadow, and status carried by a
6px dot. Tinting the whole card is opt-in via `tint`, reserved for rows that are already
exceptions (the Alerts panel).

Interaction uses the **stretched-trigger** pattern: the title is a real `<button>` whose
`::after` covers the card. This keeps the semantics honest — it is in the tab order with a
genuine accessible name — while leaving the card free to hold its own controls in `trailing`.

## Evidence patterns

The layer that turns the design system into an evidence-first OS. Everything here is
**data-first**: components accept plain, serialisable data and own their own rendering, so a
fixture never has to pre-build elements.

### StatusBadge & ConstraintTag

Two deliberately different units:

- A **StatusBadge** is an *outcome* — verified, rejected, pending. Six tones mapping to the
  `--status-*` token triplets, in three weights (`subtle` / `solid` / `outline`).
- A **ConstraintTag** is a *rule* — "no secrets in build output", "≤ 2 files per run" — plus
  whether it currently holds. It is monospace, flush, and led by a vertical mark rather than
  sitting in a rounded chip.

Keeping them apart is what stops an evidence view from reading as a wall of undifferentiated
chips. The `--status-neutral` triplet was added to the token layer for this: without it,
"pending" had no home and every component reached for `--text-muted`, and the states drifted
apart.

### EvidenceCard

A composite record of one run: intent, scope, the five ordered gates, a verdict, and the
constraints checked along the way.

Deliberately **not** a stack of badges — the five checks are an *ordered list of gates*, so
they render as a pipeline with distinct glyphs (`✓ ✕ ◐ —`). Each outcome maps to a colour
*and* a distinct mark, so meaning survives greyscale and colour-blindness. The mini chart is
one `<rect>` per check inside a single SVG with `role="img"` and an `aria-label`, rather than a
row of styled divs, so it renders as an actual bar and announces as one unit.

### PolicyPanel

The side rail that answers *"why was this accepted?"* without leaving the surface. Branches
are tone-coded, with nested decision nodes threaded by a continuous guide rail so the tree
reads as a tree.

### CommandPalette (⌘K)

Mounted through a portal on `<body>` so it is never clipped by a panel's `overflow` and always
clears the rail's stacking context.

Follows the WAI-ARIA **combobox** pattern: the input owns `aria-expanded`, `aria-controls` and
`aria-activedescendant`; results are a `listbox` of `option`s. One tab stop, and the screen
reader announces the active option without focus ever leaving the input. `useCommandPalette()`
supplies the global ⌘K/Ctrl+K binding, kept separate so the palette stays a controlled
component.

## Testing

```bash
npm test    # render tests across @celastyle/ui
```

The render tests render each component to static markup and assert on the output rather than
on implementation details. That is aimed at what actually regresses silently in this package:
the ARIA semantics and the data rendering. A missing `data-outcome`, a second `tabindex="0"`
appearing on the rail, or a card quietly falling back to `role="button"` all pass a type check
and fail these.

## Tailwind integration

Tailwind v4 is configured CSS-first. The app maps semantic tokens into Tailwind's `--color-*`
namespace in `app/globals.css`, with renamed targets so the utility reads correctly in both
text and background position:

| Token | Mapped to | Utility |
| --- | --- | --- |
| `--text-primary` | `--color-ink-primary` | `text-ink-primary` |
| `--border-default` | `--color-edge-default` | `border-edge-default` |
| `--accent` | `--color-signal` | `bg-signal` |

Every value side is `var(--semantic-token)`, never a literal, so the light/dark themes flow
straight through the bridge.

## Commands

```bash
npm install
npm run dev        # reference app on http://localhost:3000
npm run build      # build all workspaces
npm run typecheck  # type-check all workspaces
```

Requires Node 20+.

## Accessibility

- Status is never communicated by color alone — every status dot ships with a text label
- Focus rings use the Lime accent, because focus is an active-system state and should read the
  same as selection
- `:focus-visible` throughout, so clicking never leaves a ring behind
- `prefers-reduced-motion` strips the live-indicator breath and skeleton shimmer and collapses
  transition durations, while preserving opacity fades (those carry state changes — removing
  them causes a hard state swap)
- Numeric lanes use `font-variant-numeric: tabular-nums` so live-updating values do not jitter
