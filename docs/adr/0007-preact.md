# ADR-0007: Preact for extension pages

Status: Accepted

## Context

The popup and options pages need component state (chat transcript, streaming tokens, settings forms) but are small surfaces. Options: vanilla TypeScript, Preact with signals, React, Svelte, Solid.

## Decision

Preact with signals. The popup bundle stays a few KB; JSX-less state via signals fits the message-driven streaming UI; and the API surface is a strict subset of React, so the team's mental model transfers. React was rejected for weight; Svelte/Solid for toolchain friction inside the crxjs pipeline; vanilla for the transcript and settings state complexity.

## Consequences

- Streaming chat updates flow: service worker port messages -> signal updates -> render; no store library needed.
- Bundle size stays far under store limits, leaving room for the model in the package (ADR-0002).
- If the UI ever grows beyond popup scale, migrating Preact to React is mechanical.
