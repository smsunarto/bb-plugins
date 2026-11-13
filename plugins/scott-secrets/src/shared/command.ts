/** POSIX-quote one argument for display only; nothing executes this string. */
export function quoteArg(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/u.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

export function displayCommand(argv: readonly string[]): string {
  return argv.map(quoteArg).join(" ");
}
