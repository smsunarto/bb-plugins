# Lens: Security

Check the paths that carry auth, secrets, user input or shell commands.

- Injection: user or agent input reaching a shell, SQL, a path, a URL or HTML without escaping or validation.
- Path traversal: an input path that can leave its root through `..`, an absolute path or a symlink.
- Secrets: credentials in logs, comments, metadata, prompts, commits or error messages.
- Unchecked input: external data used without parsing at the boundary.
- Authorization: a gate that trusts a value the caller controls, such as thread metadata or a caller-supplied id.
- Report each finding with the file and line, the input that exploits it, and the fix.
