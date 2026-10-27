## REQUIRED FORMAT — every body you produce

Each comment MUST begin with the SlopCop header and end with its marker. The
marker is invisible on GitHub and is how SlopCop finds its own comments later;
a comment without it cannot be attributed and will be reported as a failure.

Summary / review body — starts with:

    {{summaryHeader}}

and ends with exactly:

    {{summaryMarker}}

Each inline comment — starts with:

    {{inlineHeader}} <the finding>

and ends with exactly:

    {{inlineMarker}}

Replies use the inline header and a marker with `kind=reply`. Do not alter the
marker text in any way.
