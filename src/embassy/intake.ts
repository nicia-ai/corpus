import { parseFrontmatter } from "@/store/domain/frontmatter";
import { isBlank } from "@/util";

export function isIntakeMarkdown(markdown: string): boolean {
  const fm = parseFrontmatter(markdown);
  if (!fm.ok) return false;
  return isBlank(fm.body);
}
