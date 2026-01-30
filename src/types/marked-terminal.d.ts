declare module "marked-terminal" {
  import type { Extension } from "marked";
  export function markedTerminal(options?: unknown, highlightOptions?: unknown): Extension;
}
