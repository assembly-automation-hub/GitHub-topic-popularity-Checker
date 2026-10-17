/**
 * @fileoverview GitHub Topic Popularity Checker — client-side application.
 *
 * Queries the GitHub Search API for each user-supplied topic slug and renders
 * the live public-repository count.  All logic (normalisation, validation,
 * caching, rate-limit-aware pacing, and rendering) runs entirely in the
 * browser with no external dependencies or build step.
 *
 * The module is wrapped in an IIFE so every binding stays private; only DOM
 * side-effects are observable from outside.
 */

'use strict';

(() => {
    /* =====================================================================
       Constants & configuration
       ===================================================================== */

    /**
     * Regex that matches a valid GitHub topic slug.
     *
     * GitHub topic names allow lowercase alphanumeric characters and hyphens,
     * are 1–50 characters long, and cannot start or end with a hyphen.
     *
     * @constant {RegExp}
     */
    const TOPIC_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

    /**
     * Regex that matches a valid HTTP header token value (RFC 7230 §3.2.6).
     *
     * Only printable ASCII characters (0x21–0x7E) are permitted — no
     * whitespace, no control characters, no non-ASCII bytes.  This guards
     * against header-injection attacks if a user pastes malformed input.
     *
     * @constant {RegExp}
     */
    const TOKEN_REGEX = /^[\x21-\x7E]+$/;

    /**
     * GitHub REST API search endpoint used for per-topic repository counts.
     * @constant {string}
     */
    const GITHUB_API_URL = 'https://api.github.com/search/repositories';

    /**
     * Per-request timeout in milliseconds.
     *
     * An AbortController aborts the fetch if the server does not respond
     * within this window, preventing the UI from hanging indefinitely.
     *
     * @constant {number}
     */
    const REQUEST_TIMEOUT_MS = 10000;

    /**
     * Time-to-live for the in-memory topic-result cache, in milliseconds.
     *
     * Results expire after five minutes so that re-checking the same batch
     * is instant during a session, while stale data is not shown forever.
     *
     * @constant {number}
     */
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory cache TTL

    /**
     * Minimum delay between sequential API requests when an auth token is
     * present (higher quota tier: 30 req/min).
     * @constant {number}
     */
    const MIN_AUTH_DELAY_MS = 250;

    /**
     * Minimum delay between sequential API requests when no auth token is
     * present (lower quota tier: 10 req/min).
     * @constant {number}
     */
    const MIN_UNAUTH_DELAY_MS = 500;

    /**
     * In-memory cache mapping topic slugs to their most recent result.
     *
     * Each entry stores the repository `count` and a `timestamp` so that
     * expired entries can be evicted lazily on read.  The cache is cleared
     * automatically when the page is reloaded.
     *
     * @type {Map<string, { count: number, timestamp: number }>}
     */
    const topicCache = new Map();

    /* =====================================================================
       Cached DOM references
       ===================================================================== */

    /** @type {HTMLButtonElement} Primary "Check topics" action button. */
    const checkButton = document.getElementById('checkButton');

    /** @type {HTMLTextAreaElement} Multi-line topic input (one slug per line). */
    const topicInput = document.getElementById('topicInput');

    /** @type {HTMLInputElement} Optional GitHub PAT field (password type). */
    const tokenInput = document.getElementById('tokenInput');

    /** @type {HTMLDivElement} Container that holds rendered result rows. */
    const resultsDiv = document.getElementById('results');

    // Optional progressive-enhancement hooks; the checker works without them.
    // Each reference is checked for null before use so the app degrades
    // gracefully if the HTML structure is partially removed.

    /** @type {HTMLSpanElement|null} Inner label of the check button. */
    const checkLabel = checkButton ? checkButton.querySelector('.btn__label') : null;

    /** @type {HTMLParagraphElement|null} Status line beneath the check button. */
    const statusBar = document.getElementById('statusBar');

    /** @type {HTMLDivElement|null} Indeterminate progress rail. */
    const progressBar = document.getElementById('progressBar');

    /** @type {HTMLDivElement|null} Empty-state placeholder shown when no results exist. */
    const emptyState = document.getElementById('emptyState');

    /** @type {HTMLButtonElement|null} "Clear" action to wipe all results. */
    const clearButton = document.getElementById('clearButton');

    /** @type {HTMLSpanElement|null} Running batch summary pill (e.g. "5 topics · 3 counted"). */
    const resultSummary = document.getElementById('resultSummary');

    /** @type {HTMLSpanElement|null} Live "N topics ready" pill above the textarea. */
    const topicCountPill = document.getElementById('topicCount');

    /** @type {HTMLButtonElement|null} Eye toggle that reveals/hides the token. */
    const tokenToggle = document.getElementById('tokenToggle');

    /**
     * Original button label, captured once so it can be restored after a
     * busy state completes.
     * @constant {string}
     */
    const CHECK_LABEL = checkLabel ? checkLabel.textContent : 'Check topics';

    /* =====================================================================
       Mutable state
       ===================================================================== */

    /**
     * Re-entrancy guard that prevents overlapping batches if the user clicks
     * the check button while a previous batch is still running.
     * @type {boolean}
     */
    let isChecking = false;

    /**
     * Running tally for the current batch, used to populate the summary pill.
     *
     * @type {{ total: number, ok: number, cached: number, failed: number }}
     */
    const batch = { total: 0, ok: 0, cached: 0, failed: 0 };

    /* =====================================================================
       Utility helpers
       ===================================================================== */

    /**
     * Returns a promise that resolves after the specified delay.
     *
     * Used to insert polite pauses between API requests so the batch does
     * not saturate GitHub's rate-limit quota.
     *
     * @param {number} ms - Number of milliseconds to wait.
     * @returns {Promise<void>} A promise that resolves after `ms` milliseconds.
     *
     * @example
     * // Wait 250 ms before making the next API call.
     * await delay(250);
     */
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Normalises raw user input into a clean GitHub topic slug.
     *
     * Trims surrounding whitespace, strips any leading `#` characters (so
     * users can paste hashtag-style input), and lowercases the result.
     *
     * @param {string} raw - The raw text from a single line of the textarea.
     * @returns {string} The normalised, lowercased topic slug with no leading
     *     `#` characters or surrounding whitespace.
     *
     * @example
     * normalizeTopic('  #React  '); // => 'react'
     * normalizeTopic('Machine-Learning'); // => 'machine-learning'
     * normalizeTopic(''); // => ''
     */
    const normalizeTopic = (raw) => raw.trim().replace(/^#+/, '').toLowerCase();

    /**
     * Extracts and validates an optional GitHub Personal Access Token from
     * raw user input.
     *
     * Strips accidental `Bearer ` or `token ` prefixes that users sometimes
     * paste alongside the raw value, then verifies the cleaned token
     * contains only valid HTTP header characters.
     *
     * @param {string} rawToken - The raw token string from the password field.
     * @returns {{ token: string, valid: boolean }} An object containing the
     *     cleaned token string and a boolean indicating whether its format
     *     is acceptable for use as an HTTP Authorization header.
     *
     * @example
     * parseToken(''); // => { token: '', valid: true }
     * parseToken('Bearer ghp_abc123'); // => { token: 'ghp_abc123', valid: true }
     * parseToken('ghp_abc 123'); // => { token: 'ghp_abc 123', valid: false }
     */
    const parseToken = (rawToken) => {
        // Step 1: Strip optional auth prefixes that users commonly paste by accident
        const cleaned = rawToken.trim().replace(/^(?:Bearer|token)\s+/i, '').trim();

        // Step 2: Empty input is valid — it simply means no authentication
        if (!cleaned) {
            return { token: '', valid: true };
        }

        // Step 3: Reject tokens with characters illegal in HTTP header values
        return {
            token: cleaned,
            valid: TOKEN_REGEX.test(cleaned)
        };
    };

    /**
     * Reads a previously cached repository count for a topic, if the entry
     * exists and has not expired.
     *
     * Expired entries are deleted lazily on access to keep the map tidy
     * without requiring a background eviction timer.
     *
     * @param {string} topic - The normalised topic slug to look up.
     * @returns {number|null} The cached repository count, or `null` if no
     *     unexpired entry exists for the given topic.
     *
     * @example
     * topicCache.set('react', { count: 400000, timestamp: Date.now() });
     * getCachedCount('react'); // => 400000
     * getCachedCount('unknown'); // => null
     */
    const getCachedCount = (topic) => {
        const entry = topicCache.get(topic);

        // No entry at all — cache miss
        if (!entry) return null;

        // Evict lazily on read rather than via a background interval
        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            topicCache.delete(topic);
            return null;
        }

        return entry.count;
    };

    /* =====================================================================
       Network helpers
       ===================================================================== */

    /**
     * Performs a GET request with an AbortController-driven timeout.
     *
     * Wraps the native `fetch` API so that an in-flight request is
     * automatically aborted if the server does not respond within the
     * configured timeout window.  This prevents the UI from appearing
     * frozen when GitHub is slow or unreachable.
     *
     * @param {string} url - The fully-qualified URL to request.
     * @param {Record<string, string>} headers - HTTP headers to send with
     *     the request (e.g. Accept, Authorization).
     * @param {number} [timeoutMs=REQUEST_TIMEOUT_MS] - Maximum time in
     *     milliseconds to wait before aborting.  Defaults to
     *     {@link REQUEST_TIMEOUT_MS} (10 000 ms).
     * @returns {Promise<Response>} A promise that resolves with the
     *     server's {@link Response} on success.
     * @throws {Error} Throws `'Request timed out'` if the AbortController
     *     fires before the response arrives.
     * @throws {Error} Throws `'Network error'` for any other transport
     *     failure (DNS, connectivity, etc.).
     *
     * @example
     * const res = await fetchWithTimeout(
     *     'https://api.github.com/search/repositories?q=topic:react&per_page=1',
     *     { Accept: 'application/vnd.github+json' }
     * );
     */
    const fetchWithTimeout = async (url, headers, timeoutMs = REQUEST_TIMEOUT_MS) => {
        const controller = new AbortController();

        // Arm a one-shot timer that aborts the request if it exceeds the deadline
        const timerId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(url, {
                method: 'GET',
                headers,
                signal: controller.signal
            });
        } catch (error) {
            // Distinguish timeout from other transport failures
            if (error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw new Error('Network error');
        } finally {
            // Always release the timer to avoid leaking memory
            clearTimeout(timerId);
        }
    };

    /**
     * Calculates an adaptive delay before the next API request, based on
     * GitHub's rate-limit response headers and the number of topics
     * remaining in the current batch.
     *
     * The strategy has three tiers:
     *   1. **Quota is healthy** — use the minimal baseline delay to avoid
     *      secondary burst limits.
     *   2. **Quota is low but positive** — spread remaining requests evenly
     *      across the time until the rate-limit window resets.
     *   3. **Quota is exhausted** — wait the full duration until reset.
     *
     * @param {Response} response - The HTTP response from the most recent
     *     API call.  Rate-limit headers (`x-ratelimit-remaining`,
     *     `x-ratelimit-reset`) are read from this object.
     * @param {number} remainingTopicsCount - The number of topics still
     *     pending in the queue after the current one.  Used to decide
     *     whether the baseline delay is safe.
     * @param {boolean} hasToken - Whether the current batch is running
     *     with an authentication token, which affects the baseline delay.
     * @returns {number} The delay in milliseconds to wait before issuing
     *     the next request.  Returns `0` when no topics remain.
     *
     * @example
     * // Quota is healthy (5 000 remaining, 3 topics left):
     * computeAdaptiveDelay(response, 3, true); // => 250
     *
     * @example
     * // Quota exhausted, 60 s until reset:
     * computeAdaptiveDelay(response, 5, false); // => 60500
     */
    const computeAdaptiveDelay = (response, remainingTopicsCount, hasToken) => {
        // Nothing left to pace — skip the delay entirely
        if (remainingTopicsCount <= 0) {
            return 0;
        }

        const baseDelay = hasToken ? MIN_AUTH_DELAY_MS : MIN_UNAUTH_DELAY_MS;
        const remainingHeader = response.headers.get('x-ratelimit-remaining');
        const resetHeader = response.headers.get('x-ratelimit-reset');

        if (remainingHeader !== null) {
            const remainingQuota = Number.parseInt(remainingHeader, 10);

            // Tier 1: Quota exceeds remaining work — only a polite baseline spacing is needed
            if (!Number.isNaN(remainingQuota) && remainingQuota > remainingTopicsCount) {
                return baseDelay;
            }

            // Tier 2/3: Quota is low or exhausted — pace across the reset window
            if (!Number.isNaN(remainingQuota) && resetHeader !== null) {
                // GitHub returns reset time as a Unix epoch in seconds
                const resetEpochMs = Number.parseInt(resetHeader, 10) * 1000;
                // +500 ms safety margin to avoid hitting the exact reset boundary
                const msUntilReset = Math.max(0, resetEpochMs - Date.now()) + 500;

                // Tier 3: Quota is fully exhausted — block until the window resets
                if (remainingQuota <= 0) {
                    return msUntilReset;
                }

                // Tier 2: Spread remaining calls evenly across the reset window,
                // clamped between the baseline floor and a 10 s ceiling
                const pacedDelay = Math.ceil(msUntilReset / (remainingQuota + 1));
                return Math.max(baseDelay, Math.min(pacedDelay, 10000));
            }
        }

        // Fallback: headers missing or unparseable — use the conservative baseline
        return baseDelay;
    };

    /**
     * Fetches the public-repository count for a single validated topic from
     * the GitHub Search API.
     *
     * Includes a single automatic retry on transient server errors
     * (HTTP 502, 503, 504) and on rate-limit responses when the reset
     * window is short (≤ 15 seconds).  Fatal errors (invalid token,
     * exhausted quota with a long wait) are surfaced immediately so the
     * caller can abort the remaining batch.
     *
     * @param {string} topic - A normalised, validated topic slug.
     * @param {Record<string, string>} headers - HTTP headers to include in
     *     the request (Accept, API version, optional Authorization).
     * @returns {Promise<{ count: number, response: Response }>} An object
     *     containing the `total_count` from the API and the raw
     *     {@link Response} (used by the caller to read rate-limit headers).
     * @throws {Error} Throws with `error.fatal = true` for non-retryable
     *     conditions:
     *     - `'Invalid GitHub Token'` — HTTP 401.
     *     - `'API Rate Limit Exceeded'` — HTTP 403/429 with a long wait.
     *     Throws with `error.fatal` undefined for transient failures:
     *     - `'Invalid search query'` — HTTP 422.
     *     - `'HTTP <status>'` — any other non-success status.
     *     - `'Request failed'` — all retry attempts exhausted.
     *
     * @example
     * const { count, response } = await fetchTopicCount('react', {
     *     Accept: 'application/vnd.github+json',
     *     'X-GitHub-Api-Version': '2022-11-28'
     * });
     * console.log(count); // e.g. 412345
     */
    const fetchTopicCount = async (topic, headers) => {
        const url = `${GITHUB_API_URL}?q=topic:${encodeURIComponent(topic)}&per_page=1`;

        // Up to 2 attempts: the initial request plus one retry on eligible failures
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetchWithTimeout(url, headers);

            // Success — extract the total_count from the JSON body
            if (response.ok) {
                const data = await response.json();
                const count = typeof data.total_count === 'number' ? data.total_count : 0;
                return { count, response };
            }

            // 401 — bad or expired token; no point retrying
            if (response.status === 401) {
                const authError = new Error('Invalid GitHub Token');
                authError.fatal = true;
                throw authError;
            }

            // 403 / 429 — rate limit hit
            if (response.status === 403 || response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                const resetHeader = response.headers.get('x-ratelimit-reset');
                let waitMs = 0;

                // Prefer Retry-After (seconds); fall back to the reset epoch
                if (retryAfter !== null) {
                    waitMs = Number.parseInt(retryAfter, 10) * 1000;
                } else if (resetHeader !== null) {
                    waitMs = Math.max(0, Number.parseInt(resetHeader, 10) * 1000 - Date.now()) + 500;
                }

                // Auto-retry once when the reset window is short enough to be worth waiting
                if (attempt === 0 && waitMs > 0 && waitMs <= 15000) {
                    await delay(waitMs);
                    continue;
                }

                // Otherwise surface a fatal error so the batch stops
                const waitSec = waitMs > 0 ? Math.ceil(waitMs / 1000) : 0;
                const suffix = waitSec > 0 ? ` (reset in ${waitSec}s)` : '';
                const rateError = new Error(`API Rate Limit Exceeded${suffix}`);
                rateError.fatal = true;
                throw rateError;
            }

            // 502 / 503 / 504 — transient server errors, retry once after a brief pause
            if (attempt === 0 && (response.status === 502 || response.status === 503 || response.status === 504)) {
                await delay(1000);
                continue;
            }

            // 422 — GitHub rejected the query (should not happen with validated slugs)
            if (response.status === 422) {
                throw new Error('Invalid search query');
            }

            // Any other unexpected status — do not retry
            throw new Error(`HTTP ${response.status}`);
        }

        // Both attempts exhausted without a success or an explicit throw
        throw new Error('Request failed');
    };

    /* =====================================================================
       Presentation helpers (safe no-ops when an element is absent)
       ===================================================================== */

    /**
     * Updates the status line displayed beneath the primary check button.
     *
     * Sets both the visible text and a `data-tone` attribute that CSS uses
     * to colour the indicator dot.  This is a no-op when the status bar
     * element is not present in the DOM (progressive enhancement).
     *
     * @param {string} message - The text to display in the status line.
     * @param {'idle'|'busy'|'ok'|'error'|'warn'} [tone='idle'] - Semantic
     *     tone that maps to a colour via the `data-tone` attribute.
     *
     * @example
     * setStatus('Checking 3 topics…', 'busy');
     * setStatus('Done — 3 topics counted.', 'ok');
     */
    const setStatus = (message, tone = 'idle') => {
        if (!statusBar) return;
        statusBar.textContent = message;
        statusBar.dataset.tone = tone;
    };

    /**
     * Toggles the indeterminate progress rail between active and idle.
     *
     * Applies or removes the `is-active` CSS class, which controls the
     * sliding gradient animation.  No-op when the element is absent.
     *
     * @param {boolean} active - `true` to show the animated rail, `false`
     *     to hide it.
     */
    const setProgress = (active) => {
        if (progressBar) progressBar.classList.toggle('is-active', active);
    };

    /**
     * Synchronises the visibility of the empty-state placeholder, the clear
     * button, and the result summary pill based on whether the results
     * container has any child elements.
     *
     * Called after every DOM mutation to the results area so the chrome
     * always reflects the current state.
     */
    const syncResultsChrome = () => {
        const hasResults = Boolean(resultsDiv && resultsDiv.childElementCount > 0);
        if (emptyState) emptyState.hidden = hasResults;
        if (clearButton) clearButton.disabled = !hasResults;
        if (resultSummary) resultSummary.hidden = !hasResults;
    };

    /**
     * Refreshes the running batch summary pill with the current tallies.
     *
     * Formats the text as a dot-separated list of counts (e.g.
     * `"5 topics · 3 counted · 1 cached · 1 failed"`), omitting any
     * category that has a zero tally.  No-op when the element is absent.
     */
    const updateSummary = () => {
        if (!resultSummary) return;

        // Always show the total; append sub-tallies only when non-zero
        const parts = [`${batch.total} topic${batch.total === 1 ? '' : 's'}`];
        if (batch.ok > 0) parts.push(`${batch.ok} counted`);
        if (batch.cached > 0) parts.push(`${batch.cached} cached`);
        if (batch.failed > 0) parts.push(`${batch.failed} failed`);
        resultSummary.textContent = parts.join(' · ');
    };

    /**
     * Parses the textarea into a deduplicated, normalised list of topic
     * slugs, preserving first-seen order.
     *
     * Empty lines are silently skipped.  Topics that do not match
     * {@link TOPIC_REGEX} are still included in the returned array (so the
     * caller can render a validation error for them), but they are counted
     * in the `invalid` tally.
     *
     * @returns {{ topics: string[], invalid: number }} An object containing
     *     the ordered list of unique normalised topic slugs and the count
     *     of slugs that failed format validation.
     *
     * @example
     * // Assuming topicInput.value is "react\n#React\npython\n-invalid\n"
     * collectTopics();
     * // => { topics: ['react', 'python', '-invalid'], invalid: 1 }
     */
    const collectTopics = () => {
        const seen = new Set();
        const topics = [];
        let invalid = 0;

        // Split on newlines and normalise each line independently
        for (const line of topicInput.value.split('\n')) {
            const normalized = normalizeTopic(line);

            // Skip blank lines and duplicates (first-seen order wins)
            if (normalized.length === 0 || seen.has(normalized)) continue;
            seen.add(normalized);
            topics.push(normalized);

            // Count format violations without removing the topic
            if (!TOPIC_REGEX.test(normalized)) invalid += 1;
        }

        return { topics, invalid };
    };

    /**
     * Updates the "N topics ready" pill above the textarea to reflect the
     * current number of valid, unique topics parsed from the input.
     *
     * Displays three possible states:
     *   - `"No topics yet"` when the textarea is empty or contains only
     *     blank/duplicate lines.
     *   - `"N topics ready"` when all topics are valid.
     *   - `"N ready · M invalid"` when some topics fail format validation.
     *
     * Also sets a `data-tone` attribute (`idle`, `ok`, or `warn`) so CSS
     * can colour the pill accordingly.
     */
    const updateTopicCounter = () => {
        if (!topicCountPill) return;

        const { topics, invalid } = collectTopics();
        const valid = topics.length - invalid;

        // Empty state
        if (topics.length === 0) {
            topicCountPill.textContent = 'No topics yet';
            topicCountPill.dataset.tone = 'idle';
            return;
        }

        // Show invalid count alongside valid count when there are problems
        topicCountPill.textContent = invalid > 0
            ? `${valid} ready · ${invalid} invalid`
            : `${valid} topic${valid === 1 ? '' : 's'} ready`;
        topicCountPill.dataset.tone = invalid > 0 ? 'warn' : 'ok';
    };

    /* =====================================================================
       Result-row renderers
       ===================================================================== */

    /**
     * Renders a pending ("Loading…") state for a single result row.
     *
     * Sets the row's `data-state` attribute to `'loading'` and applies the
     * pulsing `is-loading` CSS class to the count cell.
     *
     * @param {HTMLElement} item - The result row container element.
     * @param {HTMLElement} countSpan - The span that displays the count or
     *     status text inside the row.
     */
    const renderLoading = (item, countSpan) => {
        item.dataset.state = 'loading';
        countSpan.className = 'result-count is-loading';
        countSpan.textContent = 'Loading…';
    };

    /**
     * Renders a resolved repository count for a single result row.
     *
     * Displays the count as a locale-formatted number followed by a
     * `"public repos"` unit label.  When the result was served from the
     * in-memory cache, an additional `"cached"` tag is appended.
     *
     * @param {HTMLElement} item - The result row container element.
     * @param {HTMLElement} countSpan - The span that displays the count.
     * @param {number} count - The public-repository count to display.
     * @param {boolean} fromCache - `true` if the value was served from the
     *     in-memory cache (adds a visual `"cached"` tag).
     */
    const renderCount = (item, countSpan, count, fromCache) => {
        item.dataset.state = fromCache ? 'cached' : 'ok';
        countSpan.className = 'result-count';
        countSpan.replaceChildren();

        // Build the formatted count: "412,345 public repos"
        const value = document.createElement('span');
        value.className = 'result-count__value';
        value.textContent = count.toLocaleString();

        const unit = document.createElement('span');
        unit.className = 'result-count__unit';
        unit.textContent = 'public repos';

        countSpan.append(value, unit);

        // Append the "cached" badge only for cache hits
        if (fromCache) {
            const tag = document.createElement('span');
            tag.className = 'result-count__tag';
            tag.textContent = 'cached';
            countSpan.append(tag);
        }
    };

    /**
     * Renders an error message for a single result row.
     *
     * Sets the row's `data-state` to `'error'` and displays the error
     * text in the count cell with danger-colour styling.
     *
     * @param {HTMLElement} item - The result row container element.
     * @param {HTMLElement} countSpan - The span that displays the error.
     * @param {string} message - The human-readable error description.
     */
    const renderError = (item, countSpan, message) => {
        item.dataset.state = 'error';
        countSpan.className = 'error';
        countSpan.textContent = message;
    };

    /**
     * Resets the results panel to its initial, empty presentation.
     *
     * Clears the batch tallies, removes all result-row children from the
     * DOM, and refreshes the summary pill and empty-state chrome.  Called
     * at the start of every new batch and when the user clicks "Clear".
     */
    const resetResults = () => {
        batch.total = 0;
        batch.ok = 0;
        batch.cached = 0;
        batch.failed = 0;
        if (resultsDiv) resultsDiv.replaceChildren();
        updateSummary();
        syncResultsChrome();
    };

    /* =====================================================================
       UI wiring: token reveal, quick-add chips, clear, glass modal
       ===================================================================== */

    // ---- Token visibility toggle -------------------------------------------

    // Swap the token field between password and text so the user can verify
    // what they pasted.  Update ARIA attributes so screen readers announce
    // the current state correctly.
    if (tokenToggle && tokenInput) {
        tokenToggle.addEventListener('click', () => {
            const reveal = tokenInput.type === 'password';
            tokenInput.type = reveal ? 'text' : 'password';
            tokenToggle.setAttribute('aria-pressed', String(reveal));
            tokenToggle.setAttribute('aria-label', reveal ? 'Hide token' : 'Show token');
            tokenInput.focus();
        });
    }

    // ---- Quick-add topic chips ---------------------------------------------

    // Each chip carries a `data-topic` attribute.  Clicking it appends the
    // topic to the textarea (if not already present) and flashes a brief
    // confirmation animation via the `is-added` class.
    document.querySelectorAll('.chip[data-topic]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const topic = normalizeTopic(chip.dataset.topic || '');
            if (!topic) return;

            // Only append if the topic is not already in the textarea
            const { topics } = collectTopics();
            if (!topics.includes(topic)) {
                const current = topicInput.value.replace(/\s+$/, '');
                topicInput.value = current ? `${current}\n${topic}` : topic;
            }

            updateTopicCounter();

            // Flash green confirmation, then revert after 1.2 s
            chip.classList.add('is-added');
            setTimeout(() => chip.classList.remove('is-added'), 1200);
            topicInput.focus();
        });
    });

    // ---- Clear results button ----------------------------------------------

    // Wipe the results panel and reset the status line.  The button is
    // disabled while a batch is running to prevent accidental clearing.
    if (clearButton) {
        clearButton.addEventListener('click', () => {
            if (isChecking) return;
            resetResults();
            setProgress(false);
            setStatus('Results cleared.', 'idle');
        });
    }

    // ---- Live topic counter ------------------------------------------------

    // Re-parse the textarea on every keystroke so the "N topics ready" pill
    // stays in sync without requiring a blur or submit event.
    if (topicInput) {
        topicInput.addEventListener('input', updateTopicCounter);
    }

    // ---- Glass modal (native <dialog>) -------------------------------------

    // Open: any element with `data-dialog-open="<id>"` triggers the
    // corresponding <dialog> by its id.
    document.querySelectorAll('[data-dialog-open]').forEach((trigger) => {
        trigger.addEventListener('click', () => {
            const dialog = document.getElementById(trigger.getAttribute('data-dialog-open'));
            if (dialog && !dialog.open && typeof dialog.showModal === 'function') {
                dialog.showModal();
            }
        });
    });

    // Close: clicking the glass backdrop (the dialog element itself, not its
    // inner panel) dismisses the modal.  Elements with `data-dialog-close`
    // also trigger dismissal when clicked.
    document.querySelectorAll('dialog.modal').forEach((dialog) => {
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });

        dialog.querySelectorAll('[data-dialog-close]').forEach((closer) => {
            closer.addEventListener('click', () => dialog.close());
        });
    });

    // ---- Initial render ----------------------------------------------------

    // Set the correct pill text and hide the empty-state if results already
    // exist (e.g. after a partial page restore).
    updateTopicCounter();
    syncResultsChrome();

    /* =====================================================================
       Primary action: "Check topics" click handler
       ===================================================================== */

    checkButton.addEventListener('click', async () => {
        // Prevent re-entrant invocations while a batch is in flight
        if (isChecking) return;

        // Step 1: Parse, normalise, and deduplicate topics from the textarea
        const { topics } = collectTopics();

        // Reject an empty batch immediately — no point locking the UI
        if (topics.length === 0) {
            setStatus('Add at least one topic to check.', 'warn');
            topicInput.focus();
            return;
        }

        // Step 2: Validate the optional GitHub token format
        const { token, valid: isTokenValid } = parseToken(tokenInput.value);

        // Step 3: Lock the UI into a busy state
        isChecking = true;
        checkButton.disabled = true;
        checkButton.classList.add('is-busy');
        if (checkLabel) checkLabel.textContent = 'Checking…';

        // Step 4: Clear any previous results and configure the batch tally
        resetResults();
        batch.total = topics.length;
        updateSummary();
        syncResultsChrome();
        setProgress(true);
        setStatus(`Checking ${topics.length} topic${topics.length === 1 ? '' : 's'}…`, 'busy');

        try {
            // Step 5: Build all result rows upfront in a DocumentFragment
            // (single DOM write) to avoid per-row reflow costs.
            const fragment = document.createDocumentFragment();

            /**
             * Topics that require a network request (i.e. not cached, not
             * already invalid).  Each entry keeps references to its DOM
             * nodes so the renderer can update them in-place later.
             * @type {Array<{ topic: string, item: HTMLElement, countSpan: HTMLElement }>}
             */
            const pendingQueue = [];

            for (const topic of topics) {
                const item = document.createElement('div');
                item.className = 'result-item';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'topic-name';
                nameSpan.textContent = topic;

                const countSpan = document.createElement('span');

                if (!isTokenValid) {
                    // Token format is invalid — mark every row without sending requests
                    renderError(item, countSpan, 'Invalid Token Format');
                    batch.failed += 1;
                } else if (!TOPIC_REGEX.test(topic)) {
                    // Reject malformed topics client-side to prevent query
                    // injection and conserve the API rate-limit quota
                    renderError(item, countSpan, 'Invalid topic format');
                    batch.failed += 1;
                } else {
                    const cachedCount = getCachedCount(topic);
                    if (cachedCount !== null) {
                        // Serve from cache — no network call needed
                        renderCount(item, countSpan, cachedCount, true);
                        batch.cached += 1;
                    } else {
                        // Needs a live API call — enqueue for the sequential loop
                        renderLoading(item, countSpan);
                        pendingQueue.push({ topic, item, countSpan });
                    }
                }

                item.appendChild(nameSpan);
                item.appendChild(countSpan);
                fragment.appendChild(item);
            }

            // Single DOM write: attach all rows at once
            resultsDiv.appendChild(fragment);
            updateSummary();

            // Early-exit when every row was resolved without the network
            if (!isTokenValid) {
                setStatus('Token format rejected — no request was sent to GitHub.', 'error');
                return;
            }

            if (pendingQueue.length === 0) {
                setStatus(batch.failed > 0
                    ? 'Nothing to fetch — fix the highlighted topics.'
                    : `All ${batch.cached} topic${batch.cached === 1 ? '' : 's'} served from the 5-minute cache.`, 'ok');
                return;
            }

            // Step 6: Build the request headers
            const headers = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            };

            // Attach Bearer auth only when a token was supplied
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            /**
             * Captures a fatal error message so the batch can stop early
             * and display a single summary instead of N identical errors.
             * @type {string}
             */
            let fatalMessage = '';

            // Step 7: Sequential request loop with adaptive pacing
            for (let i = 0; i < pendingQueue.length; i++) {
                const { topic, item, countSpan } = pendingQueue[i];
                const remainingAfterCurrent = pendingQueue.length - 1 - i;

                setStatus(`Fetching ${topic} — ${i + 1} of ${pendingQueue.length}…`, 'busy');

                try {
                    const { count, response } = await fetchTopicCount(topic, headers);

                    // Cache the result so re-checks within 5 min are instant
                    topicCache.set(topic, { count, timestamp: Date.now() });
                    renderCount(item, countSpan, count, false);
                    batch.ok += 1;
                    updateSummary();

                    // Pace the next request based on rate-limit headers
                    const waitMs = computeAdaptiveDelay(response, remainingAfterCurrent, Boolean(token));
                    if (waitMs > 0) {
                        await delay(waitMs);
                    }
                } catch (error) {
                    renderError(item, countSpan, error.message);
                    batch.failed += 1;
                    updateSummary();

                    // Fatal errors (bad token, exhausted quota) stop the
                    // remaining batch to avoid repeated failures and
                    // potential IP lockouts
                    if (error.fatal) {
                        fatalMessage = error.message;
                        for (let j = i + 1; j < pendingQueue.length; j++) {
                            renderError(pendingQueue[j].item, pendingQueue[j].countSpan, error.message);
                            batch.failed += 1;
                        }
                        updateSummary();
                        break;
                    }
                }
            }

            // Step 8: Final status message based on overall outcome
            if (fatalMessage) {
                setStatus(`Stopped early: ${fatalMessage}`, 'error');
            } else if (batch.failed > 0) {
                setStatus(`Finished with ${batch.failed} failed topic${batch.failed === 1 ? '' : 's'}.`, 'warn');
            } else {
                setStatus(`Done — ${batch.ok + batch.cached} topic${(batch.ok + batch.cached) === 1 ? '' : 's'} counted.`, 'ok');
            }
        } finally {
            // Step 9: Always unlock the UI, even if an unexpected error occurs
            isChecking = false;
            checkButton.disabled = false;
            checkButton.classList.remove('is-busy');
            if (checkLabel) checkLabel.textContent = CHECK_LABEL;
            setProgress(false);
            syncResultsChrome();
            updateTopicCounter();
        }
    });
})();
