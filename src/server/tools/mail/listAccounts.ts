import { getAccounts } from "../../../domains/mail/index/accountMap.ts";
import type { ToolModule } from "../../../types.ts";

export const TOOL: ToolModule = {
  name: "mail_list_accounts",
  description:
    "List all configured Apple Mail accounts with their display names and internal UUIDs.",
  inputShape: {},
  domain: "mail",
  handler: async () => {
    const accounts = await getAccounts();
    return { accounts };
  },
};
