import type { MetadataRoute } from "next";

// Lets the CRM be installed to the home screen. On iPhone this is
// required for push notifications (iOS only allows Web Push for
// installed web apps).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Wangoes DSA CRM",
    short_name: "DSA CRM",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#7c3aed",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
