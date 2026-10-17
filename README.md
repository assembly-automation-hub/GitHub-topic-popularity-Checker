# GitHub Topic Popularity Checker

A lightweight, dependency-free browser tool that reports how many public GitHub repositories match each topic using GitHub's official REST API.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue?style=for-the-badge)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/assembly-automation-hub/GitHub-topic-popularity-Checker?style=for-the-badge)](https://github.com/assembly-automation-hub/GitHub-topic-popularity-Checker/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/assembly-automation-hub/GitHub-topic-popularity-Checker?style=for-the-badge)](https://github.com/assembly-automation-hub/GitHub-topic-popularity-Checker/issues)

> [!NOTE]
> This repository is a client-side web application, not a logging library or a packaged JavaScript module. There is no backend service, package manager configuration, build pipeline, or installable library API.

## Table of Contents

- [Features](#features)
- [Tech Stack & Architecture](#tech-stack--architecture)
  - [Project Structure](#project-structure)
  - [Key Design Decisions](#key-design-decisions)
- [Design System & Theme](#design-system--theme)
  - [Layers](#layers)
  - [Theme Tokens](#theme-tokens)
  - [Component Behavior](#component-behavior)
  - [Retheming](#retheming)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
- [Testing](#testing)
- [Deployment](#deployment)
- [Usage](#usage)
- [Configuration](#configuration)
- [License](#license)
- [Contacts & Community Support](#contacts--community-support)

## Features

- **Bulk topic lookup:** Submit multiple topics in a single batch, one topic per line.
- **Input normalization:** Trims surrounding whitespace, removes leading `#` characters, and converts topic names to lowercase.
- **Stable deduplication:** Removes repeated normalized topics while preserving their first-seen order.
- **Client-side validation:** Accepts topic slugs of up to 50 lowercase alphanumeric or hyphen characters; a slug cannot begin or end with a hyphen. Invalid input is rejected before a request is made.
- **Public repository counts:** Queries GitHub's [`GET /search/repositories`](https://docs.github.com/en/rest/search/search#search-repositories) endpoint with `topic:<slug>` and displays the returned `total_count`.
- **Adaptive API pacing:** Reads rate-limit headers and adjusts spacing between sequential requests. It uses a small baseline delay when quota is healthy and spreads requests out as the remaining quota approaches exhaustion.
- **Short-lived in-memory cache:** Reuses a topic's result for five minutes in the current page session, avoiding repeat API calls. Cached values are cleared when the page is reloaded or closed.
- **Resilient requests:** Applies a 10-second timeout, retries transient `502`, `503`, and `504` responses once, and retries a rate-limited request once when the reported reset is within 15 seconds.
- **Fail-fast handling:** Stops the current batch after a fatal authentication or rate-limit failure instead of repeatedly making requests that cannot succeed.
- **Optional GitHub token:** An optional Personal Access Token raises the applicable Search API request limit. The token is only kept in the password field and request-handling memory; the application does not write it to browser storage or cookies.
- **Minimal attack surface:** No third-party runtime dependencies, analytics, backend, or build tooling. The page's Content Security Policy restricts connections to `api.github.com` and scripts/styles to same-origin files.
- **Dark glassmorphism interface:** Every navbar, panel, card, input, and modal is translucent frosted glass — `rgba(255, 255, 255, 0.05)` over `backdrop-filter: blur(18px) saturate(160%)` with a hairline `rgba(255, 255, 255, 0.12)` border — floating on a fixed `#0f0c29 → #302b63 → #24243e` gradient. Soft violet (`#a78bfa`) and electric blue (`#60a5fa`) carry buttons, active states, links, and focus rings. No surface on the page is solid or opaque.
- **Token-driven theming:** Colors, radii, blurs, shadows, and type are CSS custom properties declared once on `:root` and consumed by a single `.glass` primitive, so the whole look can be retuned from one block of variables.
- **Responsive, accessible interface:** Uses native HTML controls and a native `<dialog>`, labels the inputs for assistive technology, exposes results through a polite live region, includes visible keyboard-focus styling, and honors `prefers-reduced-motion`.
- **Progressive UI enhancements:** Quick-add topic chips, a live topic counter, a token reveal toggle, a batch status line, a result summary pill, an empty state, and a clear-results action are wired separately from the request pipeline; the checker still runs if any of those nodes are missing.

> [!IMPORTANT]
> GitHub's Search API quota is separate from the general REST API quota. The application sends one repository-search request per uncached, valid topic, sequentially. Large batches can take time, particularly without authentication or when nearing a rate limit.

## Tech Stack & Architecture

- **Languages:** HTML5, CSS, and vanilla JavaScript (ES6+).
- **Runtime:** Modern web browser with support for `fetch`, `AbortController`, `Map`, `Set`, and `DocumentFragment`.
- **External service:** GitHub REST API, specifically `GET /search/repositories`.
- **Dependencies:** None. There is no `package.json`, bundler, framework, server-side runtime, or external JavaScript package.

### Project Structure

```text
.
├── index.html   # UI markup, accessibility attributes, and Content Security Policy
├── style.css    # Dark glassmorphism design system: tokens, glass surfaces, responsive layout
├── script.js    # Input normalization, validation, caching, API requests, rendering, and UI wiring
├── README.md    # Project documentation
└── LICENSE      # Apache License 2.0
```

### Key Design Decisions

1. **Direct browser-to-GitHub requests:** The app is static and calls GitHub from the user's browser. There is no server to deploy or maintain, and no request proxy that would need to handle credentials.
2. **Sequential requests:** Each topic is fetched in input order rather than concurrently. This simplifies quota-aware pacing and avoids bursts that are more likely to trigger secondary limits.
3. **Validate before querying:** Topic syntax is checked against the accepted slug format before building the API query. This prevents malformed input from being treated as a search expression and avoids unnecessary API consumption.
4. **Safe DOM rendering:** User-supplied topic text and result values are assigned using `textContent`, not interpolated into HTML. Results are prepared in a `DocumentFragment` to reduce repeated DOM updates.
5. **Ephemeral cache and token handling:** The cache is an in-memory `Map` with a five-minute TTL. Tokens are not persisted across reloads and are sent only to the GitHub API endpoint allowed by the page policy.
6. **Theme lives in CSS custom properties:** The glassmorphism design system is expressed as `:root` variables plus one `.glass` primitive and component rules in `style.css`. No inline `style` attributes, injected `<style>` blocks, web fonts, or image assets are used — icons are inline SVG. That keeps the strict Content Security Policy (`style-src 'self'`, `default-src 'none'`) intact while allowing the entire palette to be retuned from a single block.

<details>
<summary>Request and result pipeline</summary>

```mermaid
flowchart TD
    A[Enter topics and optional token] --> B[Trim, remove leading #, lowercase]
    B --> C[Deduplicate while preserving input order]
    C --> D{Valid topic and token format?}
    D -- No --> E[Render validation error]
    D -- Yes --> F{Unexpired cached count?}
    F -- Yes --> G[Render cached count]
    F -- No --> H[GET api.github.com/search/repositories]
    H --> I{Response}
    I -- Success --> J[Cache total_count for 5 minutes]
    J --> K[Render public repository count]
    K --> L[Read rate-limit headers and pace next request]
    I -- Transient 5xx --> M[Retry once after 1 second]
    I -- Short rate-limit window --> N[Wait and retry once]
    I -- Fatal auth or rate limit --> O[Mark remaining topics and stop batch]
    I -- Other failure or timeout --> P[Render per-topic error]
```

The `total_count` is GitHub Search's count for the `topic:<slug>` query. It should be treated as an API search result, not as a permanent, real-time guarantee: repository visibility, indexing, and GitHub's search behavior can change.

</details>

## Design System & Theme

The interface is a dark glassmorphism theme: frosted translucent surfaces floating over a fixed deep-violet gradient. Nothing on the page is a solid opaque panel — every surface is semi-transparent glass with a hairline light border, a soft outer shadow, and a subtle top-edge sheen.

### Layers

| Layer | Implementation | Purpose |
| --- | --- | --- |
| Backdrop | `body::before`, `position: fixed; inset: 0`, `linear-gradient(135deg, #0f0c29, #302b63, #24243e)` | Full-screen base gradient that does not scroll with content. |
| Accent orbs | `body::after`, four large radial gradients on a slow `drift` animation | Gives the blur something to refract so the frost reads as glass. |
| Glass surfaces | `.glass`: `rgba(255, 255, 255, 0.05)` background, `1px solid rgba(255, 255, 255, 0.12)` border, `backdrop-filter: blur(18px) saturate(160%)`, `border-radius: 16px`, `box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4)` | Navbar, hero stat tiles, both workspace panels, footer, modal, and nested cards. |
| Content | White text with `rgba(255, 255, 255, 0.6)` secondary and `0.55` muted | Keeps copy legible over translucent surfaces. |

### Theme Tokens

All visual constants are CSS custom properties declared once on `:root` in `style.css`:

| Token | Default | Used for |
| --- | --- | --- |
| `--bg-1`, `--bg-2`, `--bg-3` | `#0f0c29`, `#302b63`, `#24243e` | Fixed backdrop gradient stops. |
| `--glass-bg` | `rgba(255, 255, 255, 0.05)` | Base fill for panels, navbar, modal, and footer. |
| `--glass-bg-raise`, `--glass-bg-sunken` | white at `0.085` and `0.035` | Hover/raised and nested/recessed surfaces. |
| `--glass-border`, `--glass-border-soft`, `--glass-border-raise` | white at `0.12`, `0.08`, `0.22` | Hairline edges, dividers, and hover edges. |
| `--glass-blur` (`-sm`, `-xs`) | `blur(18px) saturate(160%)`, `12px`, `8px` | Frost strength for surfaces, controls, and small cards. |
| `--glass-radius`, `--glass-radius-sm`, `--glass-radius-pill` | `16px`, `12px`, `999px` | Panel, control, and pill corner radii. |
| `--glass-shadow` | `0 8px 32px rgba(0, 0, 0, 0.4)` | Elevation for every floating surface. |
| `--glass-sheen` | `inset 0 1px 0 rgba(255, 255, 255, 0.08)` | Top-edge highlight that suggests glass thickness. |
| `--text`, `--text-secondary`, `--text-muted`, `--text-faint` | `#ffffff`, white at `0.6`, `0.55`, `0.45` | Type hierarchy and placeholders. |
| `--accent`, `--accent-alt` | `#a78bfa`, `#60a5fa` | Buttons, active nav state, links, focus rings, result counts. |
| `--accent-fill`, `--accent-border`, `--accent-glow` | violet at `0.14`, `0.45`, `0.28` | Tinted glass button bodies and the inner hover glow. |
| `--success`, `--danger`, `--warning` | `#6ee7b7`, `#fca5a5`, `#fcd34d` | Status tones, cached rows, and error rows. |
| `--focus-ring`, `--focus-outline` | `0 0 0 3px rgba(167, 139, 250, 0.32)` | Accent focus ring for inputs, buttons, and keyboard navigation. |
| `--shell` | `min(1120px, 100% - 2.5rem)` | Shared content width for navbar, layout, and footer. |

### Component Behavior

- **Buttons:** glass body with an accent-tinted border. Hover raises the surface, brightens the border, and adds a subtle inner glow (`inset 0 0 24px`) with a soft outer bloom; active presses scale to `0.985`; disabled drops to `0.45` opacity and loses the glow. Variants: `--primary` (violet), `--blue`, `--ghost`, `--sm`, `--block`.
- **Inputs:** no solid fill anywhere — translucent glass background, hairline border, violet caret, dim placeholder, and an accent focus ring with a faint inner bloom. `-webkit-autofill` is overridden so an autofilled token field stays translucent instead of turning white.
- **Result rows:** nested glass cards keyed by `data-state` (`loading`, `ok`, `cached`, `error`). Loading rows pulse with a blue dot; counts render as a tabular-numeral value in violet plus a `public repos` unit; cache hits add a `cached` tag; errors tint the whole row red.
- **Navbar:** a sticky floating glass bar (`top: 1rem`) with a segmented pill navigation; the active link is violet-tinted glass.
- **Modal:** a native `<dialog>` in the top layer — full-viewport glass box over a `blur(8px)` backdrop, dismissed by the close button, the footer action, `Esc`, or a click on the backdrop.
- **Motion:** short transitions, a slow-drifting orb layer, an indeterminate progress rail, and a staggered row entrance. All of it is disabled under `prefers-reduced-motion: reduce`.
- **Fallback:** engines without `backdrop-filter` match a nested `@supports` rule that swaps the glass fills for darker translucent values, preserving contrast without introducing an opaque surface.
- **Small screens:** the workspace collapses to a single column below `980px`, the results panel stops sticking, the navbar hides the external link and button labels below `760px`, and rows, headers, and modal actions reflow below `520px`.

### Retheming

Edit the `:root` block in `style.css`. Changing `--accent` and `--accent-alt` retints every button, link, chip hover, focus ring, and result count; changing `--bg-1`, `--bg-2`, and `--bg-3` repaints the fixed backdrop. No component hard-codes a color, so the palette can be shifted or inverted without touching markup or JavaScript.

## Getting Started

### Prerequisites

- A modern web browser with JavaScript enabled.
- Internet access to `https://api.github.com`.
- **Optional:** Python 3 (or another static HTTP server) if you prefer to serve the files locally rather than opening `index.html` directly.
- **Optional:** A GitHub Personal Access Token for a higher Search API request quota. No repository permissions or scopes are needed to search public repositories; use a token with no additional scopes/permissions where your token type supports that configuration.

No Node.js, Docker, database, or compilation toolchain is required.

### Installation

Clone the repository:

```bash
git clone https://github.com/assembly-automation-hub/GitHub-topic-popularity-Checker.git
cd GitHub-topic-popularity-Checker
```

Open `index.html` in a browser, or start a local static server:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

> [!TIP]
> If your browser or security policy restricts API requests from a `file://` page, use the local HTTP server. For a LAN-accessible development server, Python can bind to all interfaces with `python3 -m http.server 8000 --bind 0.0.0.0`.

<details>
<summary>Troubleshooting and alternative local serving options</summary>

- **The page loads but API requests fail:** Confirm the browser has internet access, JavaScript is enabled, and a browser extension, firewall, or network policy is not blocking `api.github.com`.
- **A file-open launch is blocked:** Serve the directory over HTTP using Python, `npx serve .`, or an equivalent static server. `npx serve` requires Node.js and downloads/runs a package; it is not a project dependency.
- **HTTP 401 / invalid token:** Remove accidental whitespace and verify the token is current. The UI accepts an optional `Bearer ` or `token ` prefix and strips it before sending the token as a Bearer credential.
- **HTTP 403 / 429:** The Search API quota may be exhausted or a secondary rate limit may apply. Wait for the reset window, reduce the batch size, or provide an optional token. The app automatically retries only a short reported wait window.
- **No result appears for a line:** Empty lines are ignored. Topic text is normalized; values that do not match GitHub's topic slug format are displayed as invalid rather than queried.

</details>

## Testing

There is currently no committed automated unit or integration test suite, and no configured test runner or linter. The following checks are available without installing project dependencies:

```bash
# Check JavaScript syntax (requires Node.js, but does not run or bundle the app)
node --check script.js

# Serve the app for manual browser testing (requires Python 3)
python3 -m http.server 8000
```

For a manual end-to-end check, open <http://localhost:8000> and verify:

1. `api`, `react`, and `python` each produce a public repository count.
2. Inputs such as ` #React ` and `react` normalize to one `react` result.
3. Empty lines are ignored and malformed slugs (for example, `-invalid`) are rejected without an API call.
4. Rechecking a topic within five minutes uses the cached result; reload the page to clear the cache.
5. A missing or invalid token, timeout, API error, and rate-limit response are reported in the corresponding result row without breaking the page.
6. Interface checks: quick-add chips append to the textarea without duplicating, the topic counter pill reflects valid and invalid lines, the eye toggle reveals and re-hides the token, **How it works** opens the glass modal (closable by button, `Esc`, or backdrop click), the progress rail and status line animate during a batch, and **Clear** restores the empty state.
7. Theme checks: the gradient stays fixed while content scrolls, every panel, input, and modal is translucent rather than opaque, focus rings are violet, and enabling `prefers-reduced-motion` stops the drifting orbs, spinner, and row entrance animations.

Browser developer tools can be used to inspect network requests and confirm requests target `api.github.com`. Do not use a real secret token in screenshots, recordings, or shared developer-tool logs.

> [!NOTE]
> There are no separate unit-test, integration-test, or lint commands such as `npm test`, `pytest`, or `flake8` because this project does not define those toolchains.

## Deployment

This application consists of static files and can be deployed to any static hosting provider that serves HTML, CSS, and JavaScript over HTTPS. No build step, container, environment-specific server process, or database migration is required.

1. Publish `index.html`, `style.css`, and `script.js` together, preserving their relative paths.
2. Enable HTTPS so the page can call GitHub's HTTPS API and users can safely enter an optional token.
3. Keep the Content Security Policy in `index.html` intact, or reproduce an equal-or-more-restrictive policy in the hosting configuration. The current policy permits connections only to `https://api.github.com`.
4. Smoke-test the deployed page by looking up a known public topic and confirming that the browser's network panel shows a request to `api.github.com`.

GitHub Pages and similar static hosting services are suitable. If using CI/CD, deployment can simply publish the repository's static root after checkout; there is no install or build command. Containerization is optional and unnecessary for the application itself.

> [!WARNING]
> Do not add a token to source files, a committed `.env` file, a deployment-time JavaScript constant, or a public build artifact. The intended flow is user-entered, ephemeral credentials. Anyone able to access a browser session can use a token entered into that session until it is cleared or the page is closed.

## Usage

1. Open the application in a browser.
2. Optionally enter a GitHub Personal Access Token in the password field to increase the Search API quota.
3. Enter one topic slug per line.
4. Select **Check topics** and read each result beside its topic.

```text
api
react
python
```

The application trims each line, strips leading `#` characters, lowercases it, and removes duplicates without changing the order of the first occurrence. For example, ` #React ` and `react` are treated as the same topic. Each successful result is displayed as a localized number followed by `public repos`; rows served from the five-minute cache also carry a `cached` tag, and failed rows are tinted red with the error message.

<details>
<summary>Advanced usage, API behavior, and edge cases</summary>

### Authentication and rate limits

The app queries GitHub's Search API. The existing application documents the following Search API limits:

| Mode | Search API limit documented by the project |
| --- | ---: |
| Unauthenticated | 10 requests per minute |
| Authenticated | 30 requests per minute |

GitHub can change quotas or apply secondary limits, so the response headers and current GitHub documentation take precedence over these reference values. A batch issues one request for every valid topic that is not already cached.

The optional token may be entered as the raw token, `Bearer <token>`, or `token <token>`. The app trims whitespace and sends the cleaned value as `Authorization: Bearer …`. No scopes are required for searching public repositories. Never paste a token into a shared or untrusted browser session.

### Error and retry behavior

- Each network request has a 10-second timeout.
- HTTP `502`, `503`, and `504` are retried once after a one-second delay.
- HTTP `403` or `429` is treated as a rate-limit condition. When `Retry-After` or `X-RateLimit-Reset` indicates a wait of 15 seconds or less, the app waits and retries once. Longer waits are reported and remaining requests are stopped.
- HTTP `401` is treated as a fatal invalid-token error and stops the batch.
- Other non-success responses are shown as per-topic errors. A `422` is reported as an invalid search query.
- Successful values are cached for five minutes in the current page context. Errors are not cached.

### Data and privacy boundaries

The page does not use `localStorage`, `sessionStorage`, or cookies for tokens or counts. A token is still visible to the browser runtime and is sent to GitHub as an authorization header; do not treat browser-side handling as equivalent to a server-side secret vault. The policy in the HTML restricts `connect-src` to GitHub's API, disallows external scripts and styles, and sets `Referrer-Policy` to `no-referrer`.

</details>

## Configuration

There is no `.env` file, configuration file, startup flag, or runtime settings screen. The application is configured by its source constants in `script.js` and security policy in `index.html`. The token is optional user input and is not a deployment configuration value.

<details>
<summary>Built-in settings and defaults</summary>

| Setting | Current default | Purpose |
| --- | --- | --- |
| GitHub API endpoint | `https://api.github.com/search/repositories` | Repository search endpoint used for each topic. |
| GitHub API version header | `2022-11-28` | Version sent in `X-GitHub-Api-Version`. |
| Accepted topic syntax | Lowercase letters, digits, and hyphens; 1–50 characters; no leading/trailing hyphen | Prevents invalid or unsafe topic search terms. Input is lowercased before validation. |
| Request timeout | `10,000 ms` | Aborts an individual fetch if it does not complete. |
| Cache TTL | `5 minutes` | Lifetime of successful topic counts in the in-memory cache. |
| Minimum delay with token | `250 ms` | Baseline spacing between requests when quota is sufficient. |
| Minimum delay without token | `500 ms` | Baseline spacing between requests when quota is sufficient. |
| Maximum paced delay | `10,000 ms` | Upper bound for calculated per-request pacing while quota remains. Exhausted quota waits until the reset time. |
| Short rate-limit retry window | `15 seconds` | Maximum reported wait for one automatic rate-limit retry. |
| Transient server retry | Once, after `1 second` | Applies to `502`, `503`, and `504`. |
| CSP connection source | `https://api.github.com` | Only allowed connection target in the page's Content Security Policy. |
| Token persistence | None | Token remains transient in the current page session and is not written to browser storage. |

</details>

## License

This project is licensed under the [Apache License 2.0](LICENSE). See the license text for the full terms, conditions, and permissions.

## Contacts & Community Support

## Support the Project

  [![DevsInExile-Studio](https://img.shields.io/badge/Devs_In_Exile-Studio-181717?style=flat-square)](https://devs-in-exile.pages.dev/)
  [![Patreon](https://img.shields.io/badge/Patreon-OstinFCT-f96854?style=flat-square&logo=patreon)](https://www.patreon.com/OstinFCT)
  [![Ko-fi](https://img.shields.io/badge/Ko--fi-fctostin-29abe0?style=flat-square&logo=ko-fi)](https://ko-fi.com/fctostin)
  [![Boosty](https://img.shields.io/badge/Boosty-Support-f15f2c?style=flat-square)](https://boosty.to/ostinfct)
  [![YouTube](https://img.shields.io/badge/YouTube-FCT--Ostin-red?style=flat-square&logo=youtube)](https://www.youtube.com/@FCT-Ostin)
  [![Telegram](https://img.shields.io/badge/Telegram-FCTostin-2ca5e0?style=flat-square&logo=telegram)](https://t.me/FCTostin)

If you find this tool useful, consider leaving a star on GitHub or supporting the author directly.
