# Product

## Register

product

## Users

Developers and AI-tool power users who manage multiple Codex, Claude, Factory, Grok, and
Antigravity accounts from a terminal. They need to check quota at a glance, often in narrow split panes,
without interrupting their current workflow.

## Product Purpose

Codex Quota provides one dependable CLI for account management, credential synchronization,
and quota monitoring across supported AI providers. Success means current account and quota
state is fast to scan, safe to act on, and equally usable in wide terminals, narrow panes,
scripts, and no-color environments.

## Brand Personality

Compact, direct, trustworthy. The tool should feel native to the terminal and quietly
competent, with information taking priority over decoration.

## Anti-references

Avoid decorative dashboard styling, novelty terminal effects, verbose status narration,
and layouts that assume a full-width terminal. Do not trade away useful quota details merely
to make the output fit.

## Design Principles

- Optimize for a quick, accurate quota scan.
- Adapt structure to the available terminal width instead of relying on terminal auto-wrap.
- Preserve information and hierarchy when space is constrained.
- Keep output deterministic for users, tests, and downstream scripts.
- Make no-color and non-interactive output first-class experiences.

## Accessibility & Inclusion

Meaning must not depend on color. Text and box structure must remain readable without ANSI
styling, must not overflow narrow terminals, and must preserve clear labels for screen-reader
and copied-text use.
