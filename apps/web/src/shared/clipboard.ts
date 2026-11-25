/**
 * Adapted from references/buzz-app/src/shared/clipboard.ts (Tauri invoke stripped for Web).
 */
export function writeClipboardText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
