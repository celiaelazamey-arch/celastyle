# @celastyle/tokens

The foundation of CelaStyle. Framework-agnostic design tokens as plain CSS custom properties
— no build step, no runtime, no React.

```css
@import "@celastyle/tokens";
```

## Contract

**Components reference the semantic layer, never the primitives.**

```css
/* correct */
.my-panel {
  background: var(--surface-raised);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
}

/* wrong — a raw ramp value is not a role */
.my-panel {
  background: var(--graphite-900);
}
```

If a component needs a value with no semantic token, that is a gap in this package — add the
token here rather than reaching into `--graphite-*` or `--lime-*`. Reaching past the semantic
layer is how a design system stops being able to re-theme.

## What's in the box

- **Graphite** — a cool neutral ramp, saturation held under ~8% so nothing competes with the
  accent
- **Lime** — the signal color, reserved for live / selected / primary. Never decorative.
- **Status** — success, warning, danger, info; each with a paired alpha set so a status can be
  a tinted fill plus a solid dot without hand-authoring transparency
- **Foundations** — type, spacing (4px grid), radius, elevation, motion, z-index layers
- **Themes** — dark (default) and light, mapping primitives to roles

## Theming

Set one attribute on `<html>`:

```html
<html data-theme="light">
```

Dark is the default when the attribute is absent. Every semantic token resolves correctly in
both themes, and the accent deliberately changes weight between them — see the note in
`src/themes/light.css`.

## Naming

`--graphite-*`, `--lime-*`, `--status-*-*` are primitives. `--surface-*`, `--text-*`,
`--border-*`, `--accent*`, `--status-*` are semantic. The two namespaces are kept visually
distinct on purpose: if a name reads like one of those prefixes, it is a role, not a color.

## Performance note

The whole package is ~10KB of CSS, unparsed. It ships as-is — there is no build step and no
tree-shaking to configure.
