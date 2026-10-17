import { api, db, BotApiError } from 'sdk';
import { eq } from 'sdk/db';
import { packs } from '../schema.js';
import {
  getBotUsername, getPack, setNameFor, packLink, parseEmoji,
  toInputSticker, countStickers, MAX_STICKERS,
} from '../lib/pack.js';
import { reply, mention, escapeHtml, isAdmin } from '../lib/chat.js';

const HELP = [
  '<b>Group sticker pack</b>',
  '',
  'Reply to any sticker with:',
  '/add — add it to this group\'s pack (optionally with emoji, e.g. <code>/add 😂🔥</code>)',
  '',
  '/pack — get the link to the pack',
  '/remove — (admins) reply to a sticker from the pack to remove it',
  '/rename &lt;title&gt; — (admins) rename the pack',
].join('\n');

export default async function (message) {
  // A basic group upgraded to a supergroup gets a new chat id — carry the pack over.
  if (message.migrate_to_chat_id) {
    await db.update(packs)
      .set({ chatId: message.migrate_to_chat_id })
      .where(eq(packs.chatId, message.chat.id))
      .run();
    return;
  }

  const m = (message.text ?? '').match(/^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/);
  if (!m) return;
  const [, cmd, target, rawArgs = ''] = m;
  if (target && target.toLowerCase() !== (await getBotUsername()).toLowerCase()) return;
  const args = rawArgs.trim();

  const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';
  if (!isGroup) return privateChat(message, cmd);

  try {
    switch (cmd) {
      case 'add':    return await add(message, args);
      case 'pack':   return await showPack(message);
      case 'remove': return await remove(message);
      case 'rename': return await rename(message, args);
      case 'help':
      case 'start':  return await reply(message, HELP);
    }
  } catch (e) {
    console.error(e);
    const why = e instanceof BotApiError ? e.description : 'something went wrong';
    await reply(message, `⚠️ ${escapeHtml(why)}`);
  }
}

async function add(message, args) {
  const sticker = message.reply_to_message?.sticker;
  if (!sticker) return reply(message, 'Reply to a sticker with /add to put it in the group pack.');
  if (sticker.type !== 'regular') {
    return reply(message, 'Only regular stickers can be added (not custom emoji or masks).');
  }

  const chatId = message.chat.id;
  const input = toInputSticker(sticker, parseEmoji(args));
  const pack = await getPack(chatId);

  if (pack && sticker.set_name === pack.setName) {
    return reply(message, 'That sticker is already in the pack.');
  }

  if (!pack) return createPack(message, input);

  try {
    await api.addStickerToSet({ user_id: pack.ownerId, name: pack.setName, sticker: input });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    if (/STICKERS_TOO_MUCH|too much/i.test(e.description)) {
      return reply(message, `The pack is full (${MAX_STICKERS} stickers). An admin can /remove some first.`);
    }
    if (/STICKERSET_INVALID/i.test(e.description)) {
      await db.delete(packs).where(eq(packs.chatId, chatId)).run();
      return reply(message, 'The pack seems to have been deleted. Run /add again to start a new one.');
    }
    throw e;
  }

  const n = await countStickers(pack.setName);
  const by = message.from && !message.from.is_bot ? ` by ${mention(message.from)}` : '';
  return reply(
    message,
    `✅ Added${by} to <a href="${packLink(pack.setName)}">${escapeHtml(pack.title)}</a>` +
      (n ? ` (${n}/${MAX_STICKERS})` : ''),
  );
}

async function createPack(message, input) {
  const user = message.from;
  if (!user || user.is_bot) {
    return reply(message, 'Send the first /add from your own account (not anonymously) — that person becomes the pack owner.');
  }

  const username = await getBotUsername();
  const setName = setNameFor(message.chat.id, username);
  const title = `${message.chat.title || 'Group'} stickers`.slice(0, 64);

  try {
    await api.createNewStickerSet({ user_id: user.id, name: setName, title, stickers: [input] });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
    // Telegram needs the owner to have started the bot in a private chat.
    if (/PEER_ID_INVALID|user not found|USER_IS_BOT|bot was blocked/i.test(e.description)) {
      return reply(
        message,
        `To create the pack I need you as its owner, ${mention(user)}. ` +
          `<a href="https://t.me/${username}?start=owner">Start me in private</a>, then send /add here again.`,
      );
    }
    throw e;
  }

  await db.insert(packs).values({ chatId: message.chat.id, setName, title, ownerId: user.id }).run();

  return reply(
    message,
    `🎉 Created <a href="${packLink(setName)}">${escapeHtml(title)}</a> with its first sticker!\n` +
      `Everyone here can now reply to a sticker with /add. ${mention(user)} owns the pack ` +
      `and can also manage it in @Stickers.`,
  );
}

async function showPack(message) {
  const pack = await getPack(message.chat.id);
  if (!pack) return reply(message, 'No pack yet. Reply to any sticker with /add to start one.');
  const n = await countStickers(pack.setName);
  return reply(
    message,
    `📦 <a href="${packLink(pack.setName)}">${escapeHtml(pack.title)}</a>` +
      (n ? ` — ${n}/${MAX_STICKERS} stickers` : ''),
  );
}

async function remove(message) {
  if (!(await isAdmin(message))) return reply(message, 'Only group admins can remove stickers.');
  const pack = await getPack(message.chat.id);
  const sticker = message.reply_to_message?.sticker;
  if (!pack || !sticker || sticker.set_name !== pack.setName) {
    return reply(message, 'Reply to a sticker from this group\'s pack with /remove.');
  }
  await api.deleteStickerFromSet({ sticker: sticker.file_id });
  return reply(message, '🗑 Removed from the pack.');
}

async function rename(message, title) {
  if (!(await isAdmin(message))) return reply(message, 'Only group admins can rename the pack.');
  const pack = await getPack(message.chat.id);
  if (!pack) return reply(message, 'No pack yet. Reply to any sticker with /add to start one.');
  if (!title || title.length > 64) return reply(message, 'Usage: <code>/rename New title</code> (1–64 characters)');

  await api.setStickerSetTitle({ name: pack.setName, title });
  await db.update(packs).set({ title }).where(eq(packs.chatId, message.chat.id)).run();
  return reply(message, `✏️ Renamed to <a href="${packLink(pack.setName)}">${escapeHtml(title)}</a>`);
}

async function privateChat(message, cmd) {
  if (cmd !== 'start' && cmd !== 'help') return;
  const username = await getBotUsername();
  const lines = [
    '👋 Thanks for starting me!',
    '',
    'If you were creating a group pack, go back to the group and send /add again.',
    '',
    `To use me in another group: <a href="https://t.me/${username}?startgroup=1">add me to a group</a>.`,
    '',
    HELP,
  ];
  return reply(message, lines.join('\n'));
}
