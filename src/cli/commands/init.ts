import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defineCommand } from "citty";
import { CONFIG_TEMPLATE } from "../../config/configTemplate.ts";
import { DEFAULT_CONFIG_PATH } from "../../constants.ts";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Write the config.toml template to ~/.mac-mcp/config.toml.",
  },
  args: {
    force: {
      type: "boolean",
      description: "Overwrite an existing config file.",
      default: false,
    },
  },
  run({ args }) {
    const path = DEFAULT_CONFIG_PATH;
    if (existsSync(path) && !args.force) {
      process.stderr.write(`${path} already exists. Use --force to overwrite.\n`);
      process.exit(1);
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, CONFIG_TEMPLATE, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    process.stderr.write(`wrote ${path}\n`);
  },
});
