# GitHub Topic Popularity Checker

A lightweight, dependency-free web tool for checking the popularity of GitHub topics by querying the number of public repositories tagged with each topic via the official GitHub REST API.

## Overview

When choosing tags for a repository or researching technology trends on GitHub, knowing how many public repositories use a specific topic helps identify standard, widely adopted topic slugs (for example, comparing `reactjs` vs. `react`).

**GitHub Topic Popularity Checker** runs entirely in the browser with zero external dependencies or build steps.

## Key Features

- **Bulk Topic Lookup**: Check multiple GitHub topics at once by entering one topic per line.
- **Smart Input Normalization & Deduplication**: Automatically trims whitespace, strips leading `#` symbols, normalizes topic names to lowercase, and removes duplicates before querying.
- **Adaptive Rate-Limit Pacing**: Reads GitHub API rate-limit headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`) to complete batches quickly when quota is available and pace requests smoothly when approaching limits.
- **In-Memory Caching**: Recently queried topics are cached in memory (5-minute TTL) so repeated checks return instantaneously without consuming API quota.
- **Resilient Error Handling**: Includes request timeouts (`AbortController`), automatic retry on transient server errors or short rate-limit windows, and fail-fast protection on invalid tokens.
- **Privacy & Security First**: Enforces a strict Content Security Policy (`connect-src https://api.github.com`). Optional Personal Access Tokens are held only in memory during the request and are never persisted to `localStorage`, `sessionStorage`, or cookies.

## Getting Started

### 1. Clone the repository

```bash
git clone https://github.com/assembly-automation-hub/GitHub-topic-popularity-Checker.git
cd GitHub-topic-popularity-Checker
```

### 2. Run the application

Because this is a static client-side application, you can either open `index.html` directly in your browser or serve the directory with any local HTTP server:

```bash
# Using Python
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Usage

1. *(Optional)* Enter a **GitHub Personal Access Token** in the top field if you want to check a larger batch of topics at higher speed.
   - No token scopes/permissions are required to search public repositories (a fine-grained token with default public access or a classic token with no scopes selected is sufficient).
2. Enter one or more topics into the text area (**one topic per line**), for example:
   ```text
   api
   react
   python
   ```
3. Click **Check Topics** to fetch the number of public repositories for each topic.

## GitHub API Rate Limits

This tool uses the [`GET /search/repositories`](https://docs.github.com/en/rest/search/search#search-repositories) endpoint:

| Mode | Search API Rate Limit |
| :--- | :--- |
| **Unauthenticated** (no token) | **10 requests per minute** |
| **Authenticated** (with token) | **30 requests per minute** |

## Project Structure

```text
├── index.html   # Application markup and Content Security Policy headers
├── style.css    # GitHub-inspired responsive styles
├── script.js    # Topic validation, caching, adaptive rate-limit pacing, and API logic
├── README.md    # Project documentation
└── LICENSE      # Apache-2.0 License
```

## License

Licensed under the [Apache License 2.0](LICENSE).
