/**
 * Voice XML Builder — Africa's Talking compatible
 * NOTE: AT does NOT support <Pause>. Removed entirely.
 */

import { AfricasTalkingAction } from "../types/voice.ts";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildVoiceXML(actions: AfricasTalkingAction[]): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n`;

  for (const action of actions) {
    if (action.say) {
      xml += `  <Say voice="${action.say.voice}"`;
      if (action.say.playBeep !== undefined) {
        xml += ` playBeep="${action.say.playBeep}"`;
      }
      xml += `>${escapeXml(action.say.text)}</Say>\n`;
    }

    // <Pause> is NOT supported by Africa's Talking — skip silently
    // if (action.pause) { ... }

    if (action.record) {
      xml += `  <Record`;
      if (action.record.maxLength !== undefined) {
        xml += ` maxLength="${action.record.maxLength}"`;
      }
      if (action.record.timeout !== undefined) {
        xml += ` timeout="${action.record.timeout}"`;
      }
      if (action.record.finishOnKey) {
        xml += ` finishOnKey="${escapeXml(action.record.finishOnKey)}"`;
      }
      if (action.record.trimSilence !== undefined) {
        xml += ` trimSilence="${action.record.trimSilence}"`;
      }
      if (action.record.playBeep !== undefined) {
        xml += ` playBeep="${action.record.playBeep}"`;
      }
      if (action.record.callbackUrl) {
        xml += ` callbackUrl="${escapeXml(action.record.callbackUrl)}"`;
      }
      xml += ` />\n`;
    }

    if (action.redirect) {
      xml += `  <Redirect>${escapeXml(action.redirect.url)}</Redirect>\n`;
    }
  }

  xml += `</Response>`;
  return xml;
}
