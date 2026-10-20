---
name: review-quick
description: Request a quick independent review of a design or implementation.
disable-model-invocation: true
argument-hint: "[branch, plan, or review focus]"
---

The user requested a **quick** review. Use `scott_engineering_review_start` with `mode: "quick"`, the intended design or implementation, and a short summary. Follow the review-workflow skill for pinned targets and result retrieval.

BB notifies the parent when the reviewer finishes; retrieve that run with `scott_engineering_review_result` after notification rather than polling.
