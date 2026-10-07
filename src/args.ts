/**
 * `--name value` from argv. A project name with spaces pasted without quotes ("--project Nara Team") arrives as
 * several words: for `project` the words up to the next flag are one name, so the paste still works.
 */
export function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  const words: string[] = [];
  for (let j = i + 1; j < argv.length && !argv[j]!.startsWith("--"); j++) {
    words.push(argv[j]!);
    if (name !== "project") break;
  }
  return words.length ? words.join(" ") : undefined;
}
