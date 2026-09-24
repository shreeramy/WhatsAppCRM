import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatDuration,
  recordingMimeType,
  recordingStoragePath,
} from "./call-recordings";

describe("recordingMimeType", () => {
  it("derives the type from the extension when the browser gives none", () => {
    expect(recordingMimeType("Call_9876.m4a", "")).toBe("audio/mp4");
    expect(recordingMimeType("rec.AMR", "application/octet-stream")).toBe("audio/amr");
  });

  it("falls back to the browser's audio type for unknown extensions", () => {
    expect(recordingMimeType("clip.weird", "audio/x-custom")).toBe("audio/x-custom");
  });

  it("rejects non-audio files", () => {
    expect(recordingMimeType("notes.pdf", "application/pdf")).toBeNull();
  });
});

describe("recordingStoragePath", () => {
  it("scopes to account and deal and sanitises the name", () => {
    expect(recordingStoragePath("acc", "deal", "Call with Rahul (1).m4a", 42)).toBe(
      "account-acc/deal-deal/42-Call_with_Rahul_1_.m4a",
    );
  });
});

describe("formatters", () => {
  it("formats durations", () => {
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
    expect(formatDuration(null)).toBeNull();
  });

  it("formats sizes", () => {
    expect(formatBytes(500)).toBe("1 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
