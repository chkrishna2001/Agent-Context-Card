# agent-context-card

Passive context projection for long-running coding-agent sessions.

agent-context-card keeps active task evidence available while retiring conversation history that no longer needs to be sent to the model. It derives state from user messages, tool calls, and tool results; it does not ask the model to maintain memory.

Key properties:

- zero model-facing tools;
- no summarizer or classifier;
- no fixed character budget;
- exact tool-call/tool-result pairing;
- versioned file-read evidence lifetimes;
- deterministic task boundaries and failure tracking;
- telemetry stored outside model-visible context.

In a four-turn Gemma A/B test, provider input fell from 153,360 to 63,883 tokens, a 58.3% reduction, while tool calls fell from 16 to 12 and tool errors from 2 to 0.

## Pi usage

    pi --no-extensions -e C:\path\to\agent-context-card\index.ts

Commands:

- /card
- /card-new &lt;goal&gt;
- /card-reset
- /card-stats

Flags:

- --context-card-recent-turns &lt;n&gt;, default 2
- --context-card-audit on|off, default on

## Architecture

- src/core — platform-neutral task boundaries, evidence projection, execution facts, and card formatting.
- src/pi — thin Pi normalization and lifecycle adapter.
- tests — focused behavioral regression coverage.

For the complete design history, rejected alternatives, test protocol, results, and limitations, read [Design history and evaluation](docs/design-and-evaluation.md).

## Development

    bun install
    bun test
    bun x tsc --noEmit
    bun x eslint .
    bun x prettier --check .
    bun build index.ts --outdir dist --target node

Status: strong proof of concept; clean-fixture and longer-session release gates remain.
