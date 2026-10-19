# Evidence and limitations

Research date: 2026-10-19. Reference: https://crayo.ai/ (public pages only).

## Tooling actually used

| Step | Tool | Result |
| --- | --- | --- |
| REA install | `npm i rea-agents@6.7.0` (official package, repo `morluto/rea`) | Installed. Node 22.22.0 satisfies `^22.19.0`. |
| REA registration | `rea setup --client claude_code --yes` | Reported `ready`. Wrote the MCP registration to `~/.claude.json` (backup `~/.claude.json.rea.backup`) and installed the `reverse-engineer-anything` skill. |
| REA MCP tools in the session | — | **Not available.** A running Claude Code session only loads MCP servers at start, and the cloud session could not be restarted. The REA CLI (same workflows) was used instead. |
| REA website capture (`capture-browser-scenario`, `inspect-web-page`, `capture-web-screenshot`) | REA CLI + local Chromium | **Blocked.** The sandbox's egress policy rejects `crayo.ai:443` and `www.crayo.ai:443` (proxy answered 403 to CONNECT). No REA evidence about crayo.ai exists. |
| Fallback | Server-side public page fetch (HTML converted to text, then summarized) | Used for `/`, `/pricing`, `/features`, `/features/reddit-story`, `/features/fake-texts`, `/features/auto-clip`, `/features/ai-voiceover`. |

**No finding in these documents comes from REA.** Every finding below is
labeled "public page text". The fallback returns page text, link targets and
image alt text. It does not execute JavaScript, does not observe network
requests, does not capture screenshots, and passes through a summarizing model,
so wording may be paraphrased. Quotes marked verbatim were requested as
verbatim but should be re-checked against the live page.

## What was not inspected (and why)

- **Signed-in product** (`/dashboard`, `/signup` flows, the editor, exports):
  requires an account. We did not create accounts, bypass auth or access user
  data. Everything about the editor's controls is therefore *not verified*.
- **Network/API contracts:** not observed and deliberately not copied.
- **Responsive behaviour, loading and error states:** need a real browser
  session. Not verified.
- **Assets (images, fonts, logos, video):** not downloaded or reused.

## How to re-run with REA

On a machine where `crayo.ai` is reachable:

```bash
npx -y rea-agents@6.7.0 setup --client claude_code   # review, approve, restart Claude Code
# then ask Claude Code to use capture_browser_scenario on https://crayo.ai/ with
# a launch-mode Chromium and screenshots for the landing, pricing and feature pages.
```

Or from the CLI, `npx -y rea-agents@6.7.0 capture-browser-scenario <scenario.json>`
(see `rea capture-browser-scenario --schema`). Replace the "public page text"
evidence below with REA evidence IDs when that is done.

## Product guidance, not a copy

ClipForge AI uses this research only to decide which workflows matter. Its
brand, copy, layout, source code and assets are original. No proprietary API
contract, code or asset from the reference is reused.
