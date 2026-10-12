import { brandIconResponse } from "@/lib/brand-icon";

// Home-screen icon on iPhone ("Add to Home Screen" — needed for push on iOS).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return brandIconResponse(180, false);
}
