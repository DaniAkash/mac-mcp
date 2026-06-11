import { z } from "zod";
import { getEvent } from "../../../domains/calendar/calendarDb.ts";
import type { ToolModule } from "../../../types.ts";

const inputShape = {
  eventId: z
    .string()
    .min(1)
    .describe("Event UUID (from a calendar_list_events or calendar_search result)."),
};

export const TOOL: ToolModule = {
  name: "calendar_get_event",
  description:
    "Fetch a full event by UUID with description and last-modified timestamp. When no calendar contains the id, returns an error envelope { error: string }.",
  inputShape,
  domain: "calendar",
  handler: (input) => {
    const args = z.object(inputShape).parse(input);
    const event = getEvent(args.eventId);
    if (!event) {
      return Promise.resolve({ error: `No event found with id "${args.eventId}".` });
    }
    return Promise.resolve(event);
  },
};
