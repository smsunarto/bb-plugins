# ledger-cli

Reads a plain-text journal, sorts the entries by date, and prints a running
balance table that lines up in a fixed-width terminal.

A journal line is `DATE ACCOUNT AMOUNT [memo]`. Lines starting with `;` or `#`
are comments. Amounts may carry thousands separators.

    bun src/report.ts journal.txt 2024-05
