// English messages of the recording views (ADR-039). Keys are `recording.<thing>`; `{name}` is a parameter.
export const recordingEn = {
  "recording.actionFailed": "Action failed.",
  "recording.exportFailed": "Export failed.",

  "recording.review.inProgress": "Recording in progress. Stop it from the menu bar.",
  "recording.review.none": "There is no recording to review.",
  "recording.review.title": "Recording",
  "recording.review.previewFailed": "The preview could not be played. You can still save it.",
  "recording.review.size": "Size",
  "recording.review.length": "Length",
  "recording.review.sound": "Sound",
  "recording.review.file": "File",
  "recording.review.save": "Save…",
  "recording.review.copyFile": "Copy File",
  "recording.review.fileCopied": "File copied.",
  "recording.review.copyPath": "Copy Path",
  "recording.review.pathCopied": "Path copied.",
  "recording.review.exportGif": "Export as GIF…",
  "recording.review.discard": "Discard",
  "recording.review.hint":
    "The recording is a temporary file. Copies of it, and of its path, only last until you save, discard it or quit Snipvero.",

  "recording.gif.title": "Export as GIF",
  "recording.gif.frameRate": "Frame rate",
  "recording.gif.width": "Width",
  "recording.gif.progress": "GIF export progress",
  "recording.gif.choosing": "Choose where to save…",
  "recording.gif.cancelling": "Cancelling…",
  "recording.gif.cancelExport": "Cancel export",
  "recording.gif.export": "Export…",
  "recording.gif.close": "Close",
  "recording.gif.cancelled": "GIF export cancelled.",
  "recording.gif.savedOne": "GIF saved ({size}, {frames} frame).",
  "recording.gif.savedMany": "GIF saved ({size}, {frames} frames).",
  "recording.gif.estimate": "up to about {size}",

  "recording.audio.legend": "Sound",
  "recording.audio.system": "System audio",
  "recording.audio.microphone": "Microphone",
  "recording.audio.both": "System audio and microphone",
  "recording.audio.none": "None",
  "recording.audio.hint":
    "Sound is off unless you turn it on. The first time you turn on the microphone, macOS asks for permission.",
  "recording.audio.restricted":
    "Microphone access is restricted on this Mac (for example by a profile), so Snipvero cannot record it.",
  "recording.audio.denied":
    "Microphone access is off for Snipvero. Turn it on in System Settings → Privacy & Security → Microphone, then switch the microphone on here again.",
  "recording.audio.openSettings": "Open System Settings",
} as const;
