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

    let isChecking = false;

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

    checkButton.addEventListener('click', async () => {
        if (isChecking) return;

        // Parse, normalize, and deduplicate topics while preserving input order
        const seen = new Set();
        const topics = [];
        for (const line of topicInput.value.split('\n')) {
            const normalized = normalizeTopic(line);
            if (normalized.length > 0 && !seen.has(normalized)) {
                seen.add(normalized);
                topics.push(normalized);
            }
        }

        if (topics.length === 0) return;

        const { token, valid: isTokenValid } = parseToken(tokenInput.value);

        isChecking = true;
        checkButton.disabled = true;
        resultsDiv.replaceChildren();

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
                    countSpan.className = 'error';
                    countSpan.textContent = 'Invalid Token Format';
                } else if (!TOPIC_REGEX.test(topic)) {
                    // Reject malformed topics client-side to prevent query injection and save rate limits
                    countSpan.className = 'error';
                    countSpan.textContent = 'Invalid topic format';
                } else {
                    const cachedCount = getCachedCount(topic);
                    if (cachedCount !== null) {
                        countSpan.textContent = `${cachedCount.toLocaleString()} public`;
                    } else {
                        countSpan.textContent = 'Loading...';
                        pendingQueue.push({ topic, countSpan });
                    }
                }

                item.appendChild(nameSpan);
                item.appendChild(countSpan);
                fragment.appendChild(item);
            }

            resultsDiv.appendChild(fragment);

            if (!isTokenValid || pendingQueue.length === 0) {
                return;
            }

            const headers = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            };

            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            for (let i = 0; i < pendingQueue.length; i++) {
                const { topic, countSpan } = pendingQueue[i];
                const remainingAfterCurrent = pendingQueue.length - 1 - i;

                try {
                    const { count, response } = await fetchTopicCount(topic, headers);
                    topicCache.set(topic, { count, timestamp: Date.now() });
                    countSpan.textContent = `${count.toLocaleString()} public`;

                    const waitMs = computeAdaptiveDelay(response, remainingAfterCurrent, Boolean(token));
                    if (waitMs > 0) {
                        await delay(waitMs);
                    }
                } catch (error) {
                    countSpan.className = 'error';
                    countSpan.textContent = error.message;

                    // Abort remaining requests on fatal errors (e.g., invalid token or exhausted rate limit)
                    // to avoid repeated failed requests and potential IP lockouts.
                    if (error.fatal) {
                        for (let j = i + 1; j < pendingQueue.length; j++) {
                            pendingQueue[j].countSpan.className = 'error';
                            pendingQueue[j].countSpan.textContent = error.message;
                        }
                        break;
                    }
                }
            }
        } finally {
            isChecking = false;
            checkButton.disabled = false;
        }
    });
})();
