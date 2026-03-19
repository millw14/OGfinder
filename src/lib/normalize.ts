export function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[_\-.]/g, " ")
    .replace(/\s+/g, " ");
}
