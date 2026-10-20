---
name: review-deep
description: Request a deep independent review of a design or implementation.
disable-model-invocation: true
argument-hint: "[branch, plan, or review focus]"
---

The user requested a **deep** review. Use `scott_engineering_review_start` with `mode: "deep"`, the intended design or implementation, and a short summary. Follow the review-workflow skill for pinned targets and result retrieval.

BB notifies the parent as each reviewer finishes; retrieve that run with `scott_engineering_review_result` after notification rather than polling.
