import { describe, expect, it } from "vitest";
import {
  formatBytes,
  phoneFromRecordingName,
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

describe("phoneFromRecordingName", () => {
  it("reads numbers in common recorder file names", () => {
    expect(phoneFromRecordingName("Call recording +91 98765 43210_250930_101500.m4a")).toBe("919876543210");
    expect(phoneFromRecordingName("9876543210_20260930103000.mp3")).toBe("919876543210");
    expect(phoneFromRecordingName("Rahul (98765-43210).amr")).toBe("919876543210");
    expect(phoneFromRecordingName("919876543210.wav")).toBe("919876543210");
  });

  it("ignores dates and names without a mobile number", () => {
    expect(phoneFromRecordingName("20260930_103000.m4a")).toBeNull();
    expect(phoneFromRecordingName("Rahul Patel.m4a")).toBeNull();
  });
});
