# Review migration

Review now belongs to [Scott Engineering](../../plugins/scott-engineering). Install that plugin for the review tools, composer banner, and workflow skills.

This package is an upgrade bridge for existing installations. Install this bridge over the existing Review source, then reload Scott Engineering. Scott Engineering copies saved runs, reports, reviewer links, thread metadata, and model settings through BB's APIs, and disables this bridge after the copy succeeds. The original data remains intact. An interrupted transfer retries on the next load without overwriting imported state.

New installations do not need this package. It registers no review tools, instructions, skills, background workers, or app surfaces.
