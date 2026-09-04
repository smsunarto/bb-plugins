# notes-sync

Publishes a directory of authored markdown notes into the input tree the
static site builder reads from.

It copies notes that are new or changed, drops published notes that no longer
exist upstream, and prints one line per change followed by a summary.

    bun src/cli.ts --source ./notes --target ./site/content/notes
