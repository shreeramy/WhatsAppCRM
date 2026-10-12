import { brandIconResponse } from "@/lib/brand-icon";

// PWA / push-notification icon (see src/app/manifest.ts and public/sw.js).
export const dynamic = "force-static";

export function GET() {
  return brandIconResponse(192, false);
}
