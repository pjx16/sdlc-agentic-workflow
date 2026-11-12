# <Feature title>

<!-- Knowledge-base doc. Describes the code as it is now. At most the number of lines given in the prompt (`kbDocMaxLines`).
     Every Flow step cites file:line. No code blocks over 5 lines. -->

## Overview

2–4 sentences: what the feature does, for whom, and why it exists.

## Entry points

- `METHOD /route` — `path/to/controller.ts:12` — what it does
- Job / event / page — `path:line` — what triggers it

## Flow

1. Step in plain words — `path/to/file.ts:40`
2. …

## Data touched

- Entity / table / collection — fields read or written, and where
  (`path:line`)

## External calls

- Service or API — what is called, when, and what happens on failure
  (`path:line`)

## Edge cases and business rules

- Rule in one sentence — `path:line`

## Open questions

- Anything unclear or not verified. Remove an entry once the code answers it.
