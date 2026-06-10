import pkg from "../../package.json" with { type: "json" };

export function getVersion(): string {
  return pkg.version;
}
