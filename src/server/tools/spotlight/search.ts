import { z } from "zod";
import { spotlightSearch } from "../../../domains/spotlight/mdfind.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "Spotlight query. Plain text matches across filename + content + metadata; the full mdfind metadata query syntax is supported too (e.g. 'kMDItemContentType == \"public.image\"').",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Restrict the search to this directory tree. Must resolve under the user's home directory.",
    ),
  kind: z
    .enum(["file", "folder", "any"])
    .optional()
    .describe("Filter results by filesystem entry kind. Default 'any'."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of results to return. Default 25, hard cap 100."),
};

export const TOOL: ToolModule = {
  name: "spotlight_search",
  description:
    "Search the macOS Spotlight index for files and folders by filename, content, or metadata. Returns absolute paths plus a file/folder kind classification.",
  inputShape,
  domain: "spotlight",
  handler: async (input) => {
    const args = z.object(inputShape).parse(input);
    return spotlightSearch({
      query: args.query,
      path: args.path,
      kind: args.kind,
      limit: args.limit,
    });
  },
};
