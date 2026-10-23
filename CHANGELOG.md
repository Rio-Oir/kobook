# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-23

First public-ready snapshot.

### Added

- Local-first reading: import from a link, a file (PDF, EPUB, DOCX, HTML,
  Markdown, TXT) or a paste; typography, outline, themes and a draggable
  measure; inline Markdown styles and in-place editing.
- Highlights, notes, multi-turn Q&A and a per-article notebook.
- Library with covers, categories, tags, title search and model-written
  summaries.
- BYOK: any OpenAI-compatible endpoint, called directly from the browser.
- Optional accounts and cross-device sync through the bundled Fastify service
  (Better Auth, Prisma, PostgreSQL).
- Offline shell (service worker + IndexedDB) and a whitelisted JSON backup.
- MPL-2.0 licensing with a generated third-party notice inventory.

### Security

- SSRF-guarded URL extraction with per-hop redirect checks, DNS pinning and
  TLS verification kept on the original hostname.
- BYOK keys stay in the browser; provider errors are redacted before display.
- CSP in the release build allows one hashed inline script and no third-party
  script origin.
