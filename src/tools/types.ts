export type ToolArgs = Record<string, string | number | boolean | undefined>;

export type ToolDef = [
  string,
  Record<string, string>,
  (args: ToolArgs) => string | Promise<string>,
];
