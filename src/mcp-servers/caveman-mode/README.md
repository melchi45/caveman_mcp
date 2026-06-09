# caveman-mode

> Caveman communication mode via MCP — no install. Just add to `mcpServers`.

`caveman-mode` is an MCP server that activates caveman-style prose compression for Claude, Copilot, and any other MCP-compatible AI client. **No hooks, no plugins, no shell install.** Add one entry to your MCP config and the server injects caveman rules automatically on every session.

Cuts AI output tokens ~65–75% while keeping full technical accuracy.

## How it works

The MCP `initialize` handshake includes an `instructions` field. Most MCP clients (Claude Code, Copilot, Cursor, etc.) inject this field as system context at session start — the same effect as the hook-based install, but with zero setup beyond the config entry.

## Quick start

### Claude Code

Add to `~/.claude/settings.json`:

```jsonc
{
  "mcpServers": {
    "caveman": {
      "command": "npx",
      "args": ["-y", "caveman-mode"]
    }
  }
}
```

### VS Code Copilot

Add to `.vscode/mcp.json` or user `settings.json`:

```jsonc
{
  "mcp": {
    "servers": {
      "caveman": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "caveman-mode"]
      }
    }
  }
}
```

### Cursor / Windsurf / other MCP clients

```jsonc
{
  "mcpServers": {
    "caveman": {
      "command": "npx",
      "args": ["-y", "caveman-mode"]
    }
  }
}
```

## Tools

| Tool | What |
|---|---|
| `activate_caveman(mode?)` | Switch intensity level and return the full ruleset. Model applies rules to all subsequent responses. |
| `get_commit_rules` | Caveman commit message rules (Conventional Commits, ≤50 char subject). |
| `get_review_rules` | Caveman code review rules (one-line findings, severity-tagged). |
| `get_current_mode` | Show active mode for this session. |
| `deactivate_caveman` | Turn off caveman, return to normal prose. |

## Resources

| URI | Content |
|---|---|
| `caveman://rules` | Full caveman SKILL.md (all intensity levels) |
| `caveman://rules/commit` | Commit message rules |
| `caveman://rules/review` | Code review rules |

## Prompts

| Prompt | What |
|---|---|
| `caveman(mode?)` | Inject caveman rules for the given level |
| `caveman_commit` | Inject commit message rules |
| `caveman_review` | Inject code review rules |

## Intensity levels

| Level | Effect |
|---|---|
| `lite` | No filler/hedging. Full sentences, professional but tight. |
| `full` | Drop articles, fragments OK. Classic caveman. *(default)* |
| `ultra` | Abbreviate prose words, strip conjunctions, arrows for causality. |
| `wenyan-lite` | Semi-classical Chinese register. |
| `wenyan-full` | Full 文言文 — 80–90% character reduction. |
| `wenyan-ultra` | Extreme classical abbreviation. |

## Configuration

| Env var | Default | What |
|---|---|---|
| `CAVEMAN_DEFAULT_MODE` | `full` | Starting intensity level on server launch |

## Difference from `caveman-shrink`

| | `caveman-mode` | `caveman-shrink` |
|---|---|---|
| Purpose | Activates caveman *response style* for the model | Compresses *tool descriptions* in another MCP server's catalog |
| How | `instructions` field + tools/prompts | stdio proxy wrapping an upstream server |
| What changes | How the model writes | What the model reads about upstream tools |

Use both together: `caveman-mode` for response compression, `caveman-shrink` wrapping your other servers for input compression.

## License

MIT.
