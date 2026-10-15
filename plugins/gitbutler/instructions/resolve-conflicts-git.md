Resolve the conflicts in this ordinary Git checkout. GitButler does not manage it; use native Git here, and never run `but setup`. Run these from the repository, exactly as quoted:

{{status}}

1. Read the in-progress merge or rebase and the unmerged index entries. If no merge, rebase, or conflict remains, report that and stop. Do not start a new merge, rebase, pull, or branch switch.
2. Read each side of every conflicted file, including its base. Preserve what both sides intended where possible. If a conflict needs a product decision that the code cannot settle, ask before changing it.
3. Edit only files necessary to resolve these conflicts. Stage each resolved file by explicit path. Continue the existing merge or rebase with an editor disabled; repeat for the next conflicting commit until the original operation finishes. Do not create unrelated commits, abort the operation, reset, discard, or rewrite other branches.
4. Run the repository's quickest relevant check, then report what each side wanted, what you kept, the validation result, and any unresolved decision.

Do not push, land, rename, delete, or run GitButler commands. The parent thread's checkout stays separate from this checkout.
