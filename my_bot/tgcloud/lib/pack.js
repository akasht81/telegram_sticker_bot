import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { packs, links } from '../schema.js';

const DEFAULT_EMOJI = '🙂';
export const MAX_STICKERS = 120;

// getMe is cheap, but cache it for the life of the isolate anyway.
let me;
export async function getMe() {
  if (!me) me = await api.getMe();
  return me;
}
export async function getBotUsername() {
  return (await getMe()).username;
}

export function packLink(setName) {
  return `https://t.me/addstickers/${setName}`;
}

// Bot-created sets must end in _by_<botusername> and start with a letter.
export function setNameFor(chatId, username) {
  return `g${Math.abs(chatId)}_by_${username}`;
}

// The pack this group adds to: a linked pack if there is one, otherwise its own.
// Returns { chatId, setName, title, ownerId, linked } or null.
export async function getPack(chatId) {
  const link = await db.select().from(links).where(eq(links.chatId, chatId)).get();
  if (link) {
    const shared = await db.select().from(packs).where(eq(packs.setName, link.setName)).get();
    if (shared) return { ...shared, linked: true };
    await db.delete(links).where(eq(links.chatId, chatId)).run(); // pack is gone
  }
  const own = await db.select().from(packs).where(eq(packs.chatId, chatId)).get();
  return own ? { ...own, linked: false } : null;
}

export async function getOwnPack(chatId) {
  return db.select().from(packs).where(eq(packs.chatId, chatId)).get();
}

export async function countLinkedGroups(setName) {
  return db.$count(links, eq(links.setName, setName));
}

// Forget a pack that no longer exists on Telegram, and every link to it.
export async function forgetPack(setName) {
  await db.delete(links).where(eq(links.setName, setName)).run();
  await db.delete(packs).where(eq(packs.setName, setName)).run();
}

// 6 characters, no look-alikes (0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newLinkCode() {
  const bytes = new Uint8Array(6);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// Pull up to 20 emoji out of the command arguments, e.g. "/add 😂🔥".
export function parseEmoji(text) {
  if (!text) return [];
  const out = [];
  try {
    for (const { segment } of new Intl.Segmenter().segment(text)) {
      if (/\p{Extended_Pictographic}/u.test(segment)) out.push(segment);
    }
  } catch {
    const m = text.match(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu);
    if (m) out.push(...m);
  }
  return out.slice(0, 20);
}

// Turn a received Sticker into an InputSticker. Re-using the file_id means
// no download/re-upload, and the original format (static/animated/video) is kept.
export function toInputSticker(sticker, emoji) {
  const format = sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static';
  const emoji_list = emoji.length ? emoji : [sticker.emoji || DEFAULT_EMOJI];
  return { sticker: sticker.file_id, format, emoji_list };
}

export async function countStickers(setName) {
  try {
    const set = await api.getStickerSet({ name: setName });
    return set.stickers.length;
  } catch {
    return null;
  }
}
