# Changelog

All notable changes to the "AI Session Metrics" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-10-11
### Fixed
- **Claude Parser**: Fixed token inflation issue by deduplicating assistant message records by message ID.
- **Codex Parser**: Replaced external CLI tool requirements (`sqlite3`, `find`, `grep`) with pure Node.js FS APIs and WebAssembly SQLite (`sql.js`) for full cross-platform compatibility across Windows, macOS, and Linux.

### Changed
- Improved token metric formatting in the status bar, tooltip, and details panel to support abbreviations for millions (`M`) and billions (`B`).
- Cleaned up status bar tooltip display when live context is absent or zero.

### Added
- Added Legal section to `README.md` with links to Privacy Policy and Terms of Use.

## [1.0.0] - 2026-10-10
### Added
- Initial release of the AI Session Metrics companion extension.
- Real-time status bar monitoring for token consumption and estimated costs.
- Comprehensive details panel for active and past AI sessions (`AI Session Metrics: Show Details` command).
- Support for Claude Code (`.claude/projects/` logs).
- Support for Gemini (`.gemini/` transcripts).
- Support for Codex (`.codex/` SQLite database).
- Smart active session detection (filters out idle sessions older than 10 minutes).
- Customizable cost estimations for input/output tokens across all supported providers.

