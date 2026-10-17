'use strict';

(() => {
    // GitHub topic names allow lowercase alphanumeric characters and hyphens (max 50 chars, cannot start/end with hyphen)
    const TOPIC_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

    // Valid HTTP header token characters (printable ASCII without whitespace)
    const TOKEN_REGEX = /^[\x21-\x7E]+$/;

    const GITHUB_API_URL = 'https://api.github.com/search/repositories';
    const REQUEST_TIMEOUT_MS = 10000;
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory cache TTL
    const MIN_AUTH_DELAY_MS = 250;
    const MIN_UNAUTH_DELAY_MS = 500;

    // In-memory cache to avoid redundant API calls for recently checked topics
    const topicCache = new Map();

    const checkButton = document.getElementById('checkButton');
    const topicInput = document.getElementById('topicInput');
    const tokenInput = document.getElementById('tokenInput');
    const resultsDiv = document.getElementById('results');

    // Optional progressive-enhancement hooks; the checker works without them
    const checkLabel = checkButton ? checkButton.querySelector('.btn__label') : null;
    const statusBar = document.getElementById('statusBar');
    const progressBar = document.getElementById('progressBar');
    const emptyState = document.getElementById('emptyState');
    const clearButton = document.getElementById('clearButton');
    const resultSummary = document.getElementById('resultSummary');
    const topicCountPill = document.getElementById('topicCount');
    const tokenToggle = document.getElementById('tokenToggle');

    const CHECK_LABEL = checkLabel ? checkLabel.textContent : 'Check topics';

    let isChecking = false;
    const batch = { total: 0, ok: 0, cached: 0, failed: 0 };

    /**
     * Sleeps for a given number of milliseconds.
     * @param {number} ms
     * @returns {Promise<void>}
     */
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * Normalizes raw user input into a clean topic slug.
     * Strips leading '#' characters and converts to lowercase.
     * @param {string} raw
     * @returns {string}
     */
    const normalizeTopic = (raw) => raw.trim().replace(/^#+/, '').toLowerCase();

    /**
     * Extracts and validates the optional GitHub token.
     * Strips accidental "Bearer " or "token " prefixes.
     * @param {string} rawToken
     * @returns {{ token: string, valid: boolean }}
     */
    const parseToken = (rawToken) => {
        const cleaned = rawToken.trim().replace(/^(?:Bearer|token)\s+/i, '').trim();
        if (!cleaned) {
            return { token: '', valid: true };
        }
        return {
            token: cleaned,
            valid: TOKEN_REGEX.test(cleaned)
        };
    };

    /**
     * Reads a valid entry from the in-memory cache if it has not expired.
     * @param {string} topic
     * @returns {number | null}
     */
    const getCachedCount = (topic) => {
        const entry = topicCache.get(topic);
        if (!entry) return null;

        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
            topicCache.delete(topic);
            return null;
        }
        return entry.count;
    };

    /**
     * Performs a fetch request with an AbortController timeout.
     * @param {string} url
     * @param {Record<string, string>} headers
     * @param {number} timeoutMs
     * @returns {Promise<Response>}
     */
    const fetchWithTimeout = async (url, headers, timeoutMs = REQUEST_TIMEOUT_MS) => {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(url, {
                method: 'GET',
                headers,
                signal: controller.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw new Error('Network error');
        } finally {
            clearTimeout(timerId);
        }
    };

    /**
     * Calculates an adaptive delay before the next API request based on GitHub rate-limit headers.
     * Avoids unnecessary waiting when quota is sufficient while respecting API limits.
     * @param {Response} response
     * @param {number} remainingTopicsCount
     * @param {boolean} hasToken
     * @returns {number} Delay in milliseconds
     */
    const computeAdaptiveDelay = (response, remainingTopicsCount, hasToken) => {
        if (remainingTopicsCount <= 0) {
            return 0;
        }

        const baseDelay = hasToken ? MIN_AUTH_DELAY_MS : MIN_UNAUTH_DELAY_MS;
        const remainingHeader = response.headers.get('x-ratelimit-remaining');
        const resetHeader = response.headers.get('x-ratelimit-reset');

        if (remainingHeader !== null) {
            const remainingQuota = Number.parseInt(remainingHeader, 10);

            // If we have enough remaining quota for all remaining topics in the current batch,
            // only apply a minimal polite spacing to avoid secondary burst limits.
            if (!Number.isNaN(remainingQuota) && remainingQuota > remainingTopicsCount) {
                return baseDelay;
            }

            // If quota is low or exhausted, pace requests across the time left until reset.
            if (!Number.isNaN(remainingQuota) && resetHeader !== null) {
                const resetEpochMs = Number.parseInt(resetHeader, 10) * 1000;
                const msUntilReset = Math.max(0, resetEpochMs - Date.now()) + 500;

                if (remainingQuota <= 0) {
                    return msUntilReset;
                }

                const pacedDelay = Math.ceil(msUntilReset / (remainingQuota + 1));
                return Math.max(baseDelay, Math.min(pacedDelay, 10000));
            }
        }

        return baseDelay;
    };

    /**
     * Fetches the repository count for a single validated topic from GitHub API.
     * Includes automatic single retry on transient 5xx errors or short rate-limit windows.
     * @param {string} topic
     * @param {Record<string, string>} headers
     * @returns {Promise<{ count: number, response: Response }>}
     */
    const fetchTopicCount = async (topic, headers) => {
        const url = `${GITHUB_API_URL}?q=topic:${encodeURIComponent(topic)}&per_page=1`;

        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetchWithTimeout(url, headers);

            if (response.ok) {
                const data = await response.json();
                const count = typeof data.total_count === 'number' ? data.total_count : 0;
                return { count, response };
            }

            if (response.status === 401) {
                const authError = new Error('Invalid GitHub Token');
                authError.fatal = true;
                throw authError;
            }

            if (response.status === 403 || response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                const resetHeader = response.headers.get('x-ratelimit-reset');
                let waitMs = 0;

                if (retryAfter !== null) {
                    waitMs = Number.parseInt(retryAfter, 10) * 1000;
                } else if (resetHeader !== null) {
                    waitMs = Math.max(0, Number.parseInt(resetHeader, 10) * 1000 - Date.now()) + 500;
                }

                // Automatically wait and retry once if the reset window is short (<= 15 seconds)
                if (attempt === 0 && waitMs > 0 && waitMs <= 15000) {
                    await delay(waitMs);
                    continue;
                }

                const waitSec = waitMs > 0 ? Math.ceil(waitMs / 1000) : 0;
                const suffix = waitSec > 0 ? ` (reset in ${waitSec}s)` : '';
                const rateError = new Error(`API Rate Limit Exceeded${suffix}`);
                rateError.fatal = true;
                throw rateError;
            }

            // Retry once on transient server errors (502, 503, 504)
            if (attempt === 0 && (response.status === 502 || response.status === 503 || response.status === 504)) {
                await delay(1000);
                continue;
            }

            if (response.status === 422) {
                throw new Error('Invalid search query');
            }

            throw new Error(`HTTP ${response.status}`);
        }

        throw new Error('Request failed');
    };

    /* ----------------------------------------------------------------------
       Presentation helpers (safe no-ops when an element is absent)
       ---------------------------------------------------------------------- */

    /**
     * Updates the status line under the primary button.
     * @param {string} message
     * @param {'idle' | 'busy' | 'ok' | 'error' | 'warn'} tone
     */
    const setStatus = (message, tone = 'idle') => {
        if (!statusBar) return;
        statusBar.textContent = message;
        statusBar.dataset.tone = tone;
    };

    /** Toggles the indeterminate progress rail. */
    const setProgress = (active) => {
        if (progressBar) progressBar.classList.toggle('is-active', active);
    };

    /** Shows or hides the empty-state placeholder and the clear action. */
    const syncResultsChrome = () => {
        const hasResults = Boolean(resultsDiv && resultsDiv.childElementCount > 0);
        if (emptyState) emptyState.hidden = hasResults;
        if (clearButton) clearButton.disabled = !hasResults;
        if (resultSummary) resultSummary.hidden = !hasResults;
    };

    /** Refreshes the summary pill with the running batch tally. */
    const updateSummary = () => {
        if (!resultSummary) return;
        const parts = [`${batch.total} topic${batch.total === 1 ? '' : 's'}`];
        if (batch.ok > 0) parts.push(`${batch.ok} counted`);
        if (batch.cached > 0) parts.push(`${batch.cached} cached`);
        if (batch.failed > 0) parts.push(`${batch.failed} failed`);
        resultSummary.textContent = parts.join(' · ');
    };

    /**
     * Parses the textarea into deduplicated topics, preserving first-seen order.
     * @returns {{ topics: string[], invalid: number }}
     */
    const collectTopics = () => {
        const seen = new Set();
        const topics = [];
        let invalid = 0;

        for (const line of topicInput.value.split('\n')) {
            const normalized = normalizeTopic(line);
            if (normalized.length === 0 || seen.has(normalized)) continue;
            seen.add(normalized);
            topics.push(normalized);
            if (!TOPIC_REGEX.test(normalized)) invalid += 1;
        }

        return { topics, invalid };
    };

    /** Updates the "N topics ready" pill above the textarea. */
    const updateTopicCounter = () => {
        if (!topicCountPill) return;
        const { topics, invalid } = collectTopics();
        const valid = topics.length - invalid;

        if (topics.length === 0) {
            topicCountPill.textContent = 'No topics yet';
            topicCountPill.dataset.tone = 'idle';
            return;
        }

        topicCountPill.textContent = invalid > 0
            ? `${valid} ready · ${invalid} invalid`
            : `${valid} topic${valid === 1 ? '' : 's'} ready`;
        topicCountPill.dataset.tone = invalid > 0 ? 'warn' : 'ok';
    };

    /**
     * Renders a pending ("Loading…") count cell.
     * @param {HTMLElement} item
     * @param {HTMLElement} countSpan
     */
    const renderLoading = (item, countSpan) => {
        item.dataset.state = 'loading';
        countSpan.className = 'result-count is-loading';
        countSpan.textContent = 'Loading…';
    };

    /**
     * Renders a resolved repository count as value + unit (+ cached tag).
     * @param {HTMLElement} item
     * @param {HTMLElement} countSpan
     * @param {number} count
     * @param {boolean} fromCache
     */
    const renderCount = (item, countSpan, count, fromCache) => {
        item.dataset.state = fromCache ? 'cached' : 'ok';
        countSpan.className = 'result-count';
        countSpan.replaceChildren();

        const value = document.createElement('span');
        value.className = 'result-count__value';
        value.textContent = count.toLocaleString();

        const unit = document.createElement('span');
        unit.className = 'result-count__unit';
        unit.textContent = 'public repos';

        countSpan.append(value, unit);

        if (fromCache) {
            const tag = document.createElement('span');
            tag.className = 'result-count__tag';
            tag.textContent = 'cached';
            countSpan.append(tag);
        }
    };

    /**
     * Renders an error message for a topic row.
     * @param {HTMLElement} item
     * @param {HTMLElement} countSpan
     * @param {string} message
     */
    const renderError = (item, countSpan, message) => {
        item.dataset.state = 'error';
        countSpan.className = 'error';
        countSpan.textContent = message;
    };

    /** Resets the results panel to its initial, empty presentation. */
    const resetResults = () => {
        batch.total = 0;
        batch.ok = 0;
        batch.cached = 0;
        batch.failed = 0;
        if (resultsDiv) resultsDiv.replaceChildren();
        updateSummary();
        syncResultsChrome();
    };

    /* ----------------------------------------------------------------------
       UI wiring: token reveal, quick-add chips, clear, glass modal
       ---------------------------------------------------------------------- */

    if (tokenToggle && tokenInput) {
        tokenToggle.addEventListener('click', () => {
            const reveal = tokenInput.type === 'password';
            tokenInput.type = reveal ? 'text' : 'password';
            tokenToggle.setAttribute('aria-pressed', String(reveal));
            tokenToggle.setAttribute('aria-label', reveal ? 'Hide token' : 'Show token');
            tokenInput.focus();
        });
    }

    document.querySelectorAll('.chip[data-topic]').forEach((chip) => {
        chip.addEventListener('click', () => {
            const topic = normalizeTopic(chip.dataset.topic || '');
            if (!topic) return;

            const { topics } = collectTopics();
            if (!topics.includes(topic)) {
                const current = topicInput.value.replace(/\s+$/, '');
                topicInput.value = current ? `${current}\n${topic}` : topic;
            }

            updateTopicCounter();
            chip.classList.add('is-added');
            setTimeout(() => chip.classList.remove('is-added'), 1200);
            topicInput.focus();
        });
    });

    if (clearButton) {
        clearButton.addEventListener('click', () => {
            if (isChecking) return;
            resetResults();
            setProgress(false);
            setStatus('Results cleared.', 'idle');
        });
    }

    if (topicInput) {
        topicInput.addEventListener('input', updateTopicCounter);
    }

    document.querySelectorAll('[data-dialog-open]').forEach((trigger) => {
        trigger.addEventListener('click', () => {
            const dialog = document.getElementById(trigger.getAttribute('data-dialog-open'));
            if (dialog && !dialog.open && typeof dialog.showModal === 'function') {
                dialog.showModal();
            }
        });
    });

    document.querySelectorAll('dialog.modal').forEach((dialog) => {
        // Clicking the glass backdrop (the dialog box itself) dismisses the modal
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });

        dialog.querySelectorAll('[data-dialog-close]').forEach((closer) => {
            closer.addEventListener('click', () => dialog.close());
        });
    });

    updateTopicCounter();
    syncResultsChrome();

    checkButton.addEventListener('click', async () => {
        if (isChecking) return;

        // Parse, normalize, and deduplicate topics while preserving input order
        const { topics } = collectTopics();

        if (topics.length === 0) {
            setStatus('Add at least one topic to check.', 'warn');
            topicInput.focus();
            return;
        }

        const { token, valid: isTokenValid } = parseToken(tokenInput.value);

        isChecking = true;
        checkButton.disabled = true;
        checkButton.classList.add('is-busy');
        if (checkLabel) checkLabel.textContent = 'Checking…';
        resetResults();
        batch.total = topics.length;
        updateSummary();
        syncResultsChrome();
        setProgress(true);
        setStatus(`Checking ${topics.length} topic${topics.length === 1 ? '' : 's'}…`, 'busy');

        try {
            // Build all result rows upfront in a single DocumentFragment to minimize DOM reflows
            const fragment = document.createDocumentFragment();
            const pendingQueue = [];

            for (const topic of topics) {
                const item = document.createElement('div');
                item.className = 'result-item';

                const nameSpan = document.createElement('span');
                nameSpan.className = 'topic-name';
                nameSpan.textContent = topic;

                const countSpan = document.createElement('span');

                if (!isTokenValid) {
                    renderError(item, countSpan, 'Invalid Token Format');
                    batch.failed += 1;
                } else if (!TOPIC_REGEX.test(topic)) {
                    // Reject malformed topics client-side to prevent query injection and save rate limits
                    renderError(item, countSpan, 'Invalid topic format');
                    batch.failed += 1;
                } else {
                    const cachedCount = getCachedCount(topic);
                    if (cachedCount !== null) {
                        renderCount(item, countSpan, cachedCount, true);
                        batch.cached += 1;
                    } else {
                        renderLoading(item, countSpan);
                        pendingQueue.push({ topic, item, countSpan });
                    }
                }

                item.appendChild(nameSpan);
                item.appendChild(countSpan);
                fragment.appendChild(item);
            }

            resultsDiv.appendChild(fragment);
            updateSummary();

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

            const headers = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            };

            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            let fatalMessage = '';

            for (let i = 0; i < pendingQueue.length; i++) {
                const { topic, item, countSpan } = pendingQueue[i];
                const remainingAfterCurrent = pendingQueue.length - 1 - i;

                setStatus(`Fetching ${topic} — ${i + 1} of ${pendingQueue.length}…`, 'busy');

                try {
                    const { count, response } = await fetchTopicCount(topic, headers);
                    topicCache.set(topic, { count, timestamp: Date.now() });
                    renderCount(item, countSpan, count, false);
                    batch.ok += 1;
                    updateSummary();

                    const waitMs = computeAdaptiveDelay(response, remainingAfterCurrent, Boolean(token));
                    if (waitMs > 0) {
                        await delay(waitMs);
                    }
                } catch (error) {
                    renderError(item, countSpan, error.message);
                    batch.failed += 1;
                    updateSummary();

                    // Abort remaining requests on fatal errors (e.g., invalid token or exhausted rate limit)
                    // to avoid repeated failed requests and potential IP lockouts.
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

            if (fatalMessage) {
                setStatus(`Stopped early: ${fatalMessage}`, 'error');
            } else if (batch.failed > 0) {
                setStatus(`Finished with ${batch.failed} failed topic${batch.failed === 1 ? '' : 's'}.`, 'warn');
            } else {
                setStatus(`Done — ${batch.ok + batch.cached} topic${(batch.ok + batch.cached) === 1 ? '' : 's'} counted.`, 'ok');
            }
        } finally {
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
