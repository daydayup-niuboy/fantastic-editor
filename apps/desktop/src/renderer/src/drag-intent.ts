export function isFileDrag(types: Iterable<string>): boolean {
  return [...types].some((type) => type.toLocaleLowerCase("en-US") === "files");
}
