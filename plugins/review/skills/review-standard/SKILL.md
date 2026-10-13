---
name: review-standard
description: Request a standard independent review of a design or implementation.
disable-model-invocation: true
argument-hint: "[branch, plan, or review focus]"
---

The user requested a **standard** review. Use `review_start` with `mode: "standard"`, the intended design or implementation, and a short summary. Follow the review-workflow skill for pinned targets and result retrieval.

BB notifies the parent when the reviewer finishes; retrieve that run with `review_result` after notification rather than polling.
