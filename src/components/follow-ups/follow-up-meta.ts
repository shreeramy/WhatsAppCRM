import { CalendarClock, ListTodo, Phone, Users } from "lucide-react";
import type { FollowUpType } from "@/types";

export const FOLLOW_UP_TYPES: FollowUpType[] = ["call", "follow_up", "meeting", "task"];

export const FOLLOW_UP_TYPE_ICON: Record<FollowUpType, typeof Phone> = {
  call: Phone,
  follow_up: CalendarClock,
  meeting: Users,
  task: ListTodo,
};

/** Columns + joins every follow-up list selects. */
export const FOLLOW_UP_SELECT =
  "*, contact:contacts(id, name, phone), deal:deals(id, title)";
