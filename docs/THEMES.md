# Installation theme

A theme restyles the console for the company that runs it: its brand colours, the roundness of the
corners, its font. It is one stylesheet, `theme.css`, that the console loads in its `<head>` on every
page. Flightroom ships it empty; replace it at deploy time with your own. Name and logo are set
apart, with `INSTALLATION_NAME` and `INSTALLATION_LOGO_URL`.

## Writing a theme

The design system declares every colour as a CSS variable, holding the arguments of `hsl()`.
Override the ones you want on `:root` for the light mode and on `.dark` for the dark one:

```css
/* Inter in place of Montserrat */
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@300..700&display=swap");

:root {
    --font-sans: "Inter", "system-ui", sans-serif;
    --radius: 0.5rem;

    --primary: 221 83% 53%;             /* #2563EB */
    --primary-foreground: 0 0% 100%;
    --primary-active: 224 76% 48%;
    --primary-strong: 226 71% 40%;
    --accent: 214 100% 97%;
    --accent-foreground: 224 64% 33%;
    --accent-active: 214 95% 93%;
    --background-gradient-to: 216 100% 98%;

    --sidebar-primary: 221 83% 53%;
    --sidebar-primary-foreground: 0 0% 100%;
    --sidebar-accent: 214 100% 97%;
    --sidebar-accent-foreground: 224 64% 33%;
    --ring: 221 83% 53% / 35%;
    --sidebar-ring: 221 83% 53% / 35%;
}

.dark {
    --primary: 213 94% 68%;             /* #60A5FA */
    --primary-foreground: 201 73% 10%;
    --primary-active: 212 96% 78%;
    --primary-strong: 212 96% 78%;
    --accent: 217 47% 22%;
    --accent-foreground: 213 97% 87%;
    --accent-active: 217 47% 28%;

    --sidebar-primary: 213 94% 68%;
    --sidebar-primary-foreground: 201 73% 10%;
    --sidebar-accent: 217 47% 22%;
    --sidebar-accent-foreground: 213 97% 87%;
    --ring: 213 94% 68% / 45%;
    --sidebar-ring: 213 94% 68% / 45%;
}
```

Write `.dark` after `:root`: both have the same specificity, so the later one wins in dark mode.

The rules of the design system sit in `@layer base`, and a rule outside any cascade layer always
wins over a layered one: a plain `theme.css` overrides them whatever the order the stylesheets load
in. Do not wrap your rules in `@layer`, or they lose that.

### The variables

Each `-foreground` is the text drawn on its colour: keep the two readable together. The values
Flightroom uses are in the `theme.css` of `@flightroom/design-system`.

| Group | Variables |
| --- | --- |
| Page | `--background`, `--background-gradient-from`, `--background-gradient-to`, `--foreground`, `--foreground-secondary` |
| Surfaces | `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--muted`, `--muted-foreground` |
| Brand | `--primary`, `--primary-foreground`, `--primary-active` (hover, pressed), `--primary-strong` (links and icons on the background: it needs contrast) |
| Highlights | `--accent`, `--accent-foreground`, `--accent-active`, `--secondary`, `--secondary-foreground`, `--secondary-active` |
| States | `--destructive`, `--success`, `--warning`, `--info`, each with `-foreground`; `--destructive-active`; `--success-subtle`, `--warning-subtle`, `--info-subtle` |
| Lines | `--border`, `--input`, `--divider`, `--ring` (focus outline) |
| Sidebar | `--sidebar-background`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring` |
| Shape and type | `--radius` (smaller and larger radii are derived from it), `--font-sans` |

The sidebar and the focus rings have variables of their own: a theme that changes only `--primary`
leaves them orange. The background is a gradient from `--background-gradient-from` to
`--background-gradient-to`, drawn over `--background`.

### What is stable

The variables are the contract between a theme and the console: their names hold across releases.
Anything else a stylesheet can target, the classes and the markup of the console, changes from one
release to the next, and a rule written against it can stop working. Prefer the variables, and
check the rest of your theme again after each upgrade.

## Deploying a theme

The images serve the file from `/var/www/frontend/theme.css`. Mount yours over it.

**Docker.**

```bash
docker run -v ./acme.css:/var/www/frontend/theme.css:ro lory1990/flightroom
```

**Helm.** Keep the stylesheet in a ConfigMap and mount its key over the file with `subPath`:

```bash
kubectl create configmap flightroom-theme --from-file=theme.css=acme.css
```

```yaml
extraVolumes:
  - name: theme
    configMap:
      name: flightroom-theme
extraVolumeMounts:
  - name: theme
    mountPath: /var/www/frontend/theme.css
    subPath: theme.css
```

A `subPath` mount does not follow later changes to the ConfigMap: restart the pods after editing it.

**Local development.** Edit `frontend/public/theme.css`, without committing it.

nginx serves `theme.css` with `Expires: -1`, so browsers revalidate it at every load and a new theme
shows on the next refresh.

## What a theme does not reach

- The illustrations with colours of their own: the workshop scene, the mascot, the maintenance bay.
- The environment colour presets, which are a palette to pick from.
- The Open Graph and Twitter meta tags, the favicon and the title shown before the console loads,
  which are in `index.html`.
