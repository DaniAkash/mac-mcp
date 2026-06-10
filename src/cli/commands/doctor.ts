import { defineCommand } from "citty";
import {
  checkFullDiskAccess,
  checkHomeDirWritable,
  checkMacOsVersion,
  type PermCheck,
} from "../../utils/perms.ts";

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Probe macOS permissions and print a status checklist.",
  },
  async run() {
    const checks: PermCheck[] = [
      checkHomeDirWritable(),
      checkMacOsVersion(),
      await checkFullDiskAccess(),
    ];
    let allPass = true;
    for (const c of checks) {
      const mark = c.passed ? "ok  " : "fail";
      process.stdout.write(`[${mark}] ${c.name}\n`);
      if (c.detail) process.stdout.write(`       ${c.detail}\n`);
      if (!c.passed && c.fix) process.stdout.write(`       fix: ${c.fix}\n`);
      if (!c.passed) allPass = false;
    }
    process.exit(allPass ? 0 : 1);
  },
});
