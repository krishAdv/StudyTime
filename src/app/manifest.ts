import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "StudyTime",
    short_name: "StudyTime",
    description: "A calm study timer and class organizer.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f6f3",
    theme_color: "#3b5bdb",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
