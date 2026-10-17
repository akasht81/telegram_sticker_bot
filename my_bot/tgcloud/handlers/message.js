import { api, db, BotApiError } from 'sdk';
import { eq } from 'sdk/db';
import { packs, links, linkCodes } from '../schema.js';
import {
  getMe, getBotUsername, getPack, getOwnPack, setNameFor, packLink, parseEmoji,
  toInputSticker, countStickers, countLinkedGroups, forgetPack, newLinkCode,
  MAX_STICKERS,
} from '../lib/pack.js';
import { reply, mention, escapeHtml, isAdmin } from '../lib/chat.js';

const CODE_TTL_MINUTES = 10;
const ADD_PROMPT = 'Send the sticker as a reply to this message';

// Say what /add was actually replying to, so a missing sticker is easy to diagnose.
function describeReply(message) {
  const r = message.reply_to_message ?? message.external_reply;
  if (!r) return 'wasn\'t a reply to anything';
  if (r.forum_topic_created) return 'reached me as a plain message in this topic, not as a reply';
  if (r.animation) return 'was a reply to a GIF, not a sticker';
  if (r.photo) return 'was a reply to a photo, not a sticker';
  if (r.video) return 'was a reply to a video, not a sticker';
  if (r.document) return 'was a reply to a file, not a sticker';
  if (r.text) {
    return r.entities?.some((e) => e.type === 'custom_emoji')
      ? 'was a reply to a message with custom emoji, not a sticker'
      : 'was a reply to a text message';
  }
  return `was a reply to a message with: ${Object.keys(r).filter((k) => !['message_id', 'from', 'chat', 'date', 'sender_chat'].includes(k)).join(', ') || 'nothing I recognise'}`;
}

// The sticker a /add refers to: a normal reply, or a reply quoted from another chat.
function repliedSticker(message) {
  return message.reply_to_message?.sticker ?? message.external_reply?.sticker ?? null;
}

const HELP = [
  '<b>Group sticker pack</b>',
  '',
  'Reply to any sticker with:',
  '/add — add it to this group\'s pack (optionally with emoji, e.g. <code>/add 😂🔥</code>)',
  '',
  '/pack — get the link to the pack',
  '/rename &lt;title&gt; — (admins or pack owner) rename the pack',
  '/remove — (admins) reply to a sticker from the pack to remove it',
  '',
  '<b>Share one pack between groups</b>',
  '/link — (admins) get a code to share this group\'s pack',
  '/link &lt;code&gt; — (admins) in another group, start adding to that pack',
  '/unlink — (admins) stop sharing and go back to this group\'s own pack',
].join('\n');

export default async function (message) {
  // A basic group upgraded to a supergroup gets a new chat id — carry everything over.
  if (message.migrate_to_chat_id) {
    const from = message.chat.id;
    const to = message.migrate_to_chat_id;
    await db.update(packs).set({ chatId: to }).where(eq(packs.chatId, from)).run();
    await db.update(links).set({ chatId: to }).where(eq(links.chatId, from)).run();
    await db.update(linkCodes).set({ fromChatId: to }).where(eq(linkCodes.fromChatId, from)).run();
    return;
  }

  const isGroupChat = message.chat.type === 'group' || message.chat.type === 'supergroup';

  // A sticker sent in reply to the bot's "send the sticker" prompt.
  if (isGroupChat && message.sticker && message.reply_to_message) {
    const bot = await getMe();
    const r = message.reply_to_message;
    if (r.from?.id === bot.id && (r.text ?? '').includes(ADD_PROMPT)) {
      try {
        return await addSticker(message, message.sticker, []);
      } catch (e) {
        console.error(e);
        const why = e instanceof BotApiError ? e.description : 'something went wrong';
        return reply(message, `⚠️ ${escapeHtml(why)}`);
      }
    }
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
      case 'link':   return await link(message, args);
      case 'unlink': return await unlink(message);
      case 'debug':  return await debug(message);
      case 'help':
      case 'start':  return await reply(message, HELP);
    }
  } catch (e) {
    console.error(e);
    const why = e instanceof BotApiError ? e.description : 'something went wrong';
    await reply(message, `⚠️ ${escapeHtml(why)}`);
  }
}

const packAnchor = (pack) => `<a href="${packLink(pack.setName)}">${escapeHtml(pack.title)}</a>`;

async function add(message, args) {
  const sticker = repliedSticker(message);
  if (!sticker) {
    const r = message.reply_to_message;
    console.log('/add without a sticker', {
      chat: message.chat.id,
      isForum: !!message.chat.is_forum,
      threadId: message.message_thread_id ?? null,
      replyKeys: r ? Object.keys(r) : null,
      externalKeys: message.external_reply ? Object.keys(message.external_reply) : null,
    });
    return reply(
      message,
      `👇 ${ADD_PROMPT} and I'll add it to the pack.\n\n` +
        `<i>(I couldn't find a sticker: your /add ${describeReply(message)}.)</i>`,
    );
  }
  return addSticker(message, sticker, parseEmoji(args));
}

async function addSticker(message, sticker, emoji) {
  if (sticker.type !== 'regular') {
    return reply(message, 'Only regular stickers can be added (not custom emoji or masks).');
  }

  const input = toInputSticker(sticker, emoji);
  const pack = await getPack(message.chat.id);

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
      await forgetPack(pack.setName);
      return reply(message, 'The pack seems to have been deleted. Run /add again to start a new one.');
    }
    throw e;
  }

  const n = await countStickers(pack.setName);
  const by = message.from && !message.from.is_bot ? ` by ${mention(message.from)}` : '';
  return reply(message, `✅ Added${by} to ${packAnchor(pack)}` + (n ? ` (${n}/${MAX_STICKERS})` : ''));
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
  const shared = await countLinkedGroups(pack.setName);
  const lines = [`📦 ${packAnchor(pack)}` + (n ? ` — ${n}/${MAX_STICKERS} stickers` : '')];
  if (pack.linked) lines.push('🔗 Shared from another group. Admins can /unlink.');
  else if (shared) lines.push(`🔗 Shared with ${shared} other group${shared === 1 ? '' : 's'}.`);
  return reply(message, lines.join('\n'));
}

async function remove(message) {
  if (!(await isAdmin(message))) return reply(message, 'Only group admins can remove stickers.');
  const pack = await getPack(message.chat.id);
  const sticker = repliedSticker(message);
  if (!pack || !sticker || sticker.set_name !== pack.setName) {
    return reply(message, 'Reply to a sticker from this group\'s pack with /remove.');
  }
  await api.deleteStickerFromSet({ sticker: sticker.file_id });
  return reply(message, '🗑 Removed from the pack.');
}

async function rename(message, title) {
  const pack = await getPack(message.chat.id);
  if (!pack) return reply(message, 'No pack yet. Reply to any sticker with /add to start one.');

  const isOwner = message.from && message.from.id === pack.ownerId;
  if (!isOwner && !(await isAdmin(message))) {
    return reply(message, 'Only group admins or the pack owner can rename the pack.');
  }
  if (!title || title.length > 64) {
    return reply(message, 'Usage: <code>/rename New title</code> (1–64 characters)');
  }

  await api.setStickerSetTitle({ name: pack.setName, title });
  await db.update(packs).set({ title }).where(eq(packs.setName, pack.setName)).run();
  return reply(message, `✏️ Renamed to <a href="${packLink(pack.setName)}">${escapeHtml(title)}</a>`);
}

async function link(message, args) {
  if (!(await isAdmin(message))) return reply(message, 'Only group admins can link packs.');
  const chatId = message.chat.id;

  // /link — make a code for this group's current pack.
  if (!args) {
    const pack = await getPack(chatId);
    if (!pack) return reply(message, 'This group has no pack yet. Reply to a sticker with /add to start one first.');

    const code = newLinkCode();
    const expires = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
    await db.delete(linkCodes).where(eq(linkCodes.fromChatId, chatId)).run(); // one live code per group
    await db.insert(linkCodes).values({ code, setName: pack.setName, fromChatId: chatId, expires }).run();

    return reply(
      message,
      `🔗 To share ${packAnchor(pack)} with another group, an admin there sends:\n\n` +
        `<code>/link ${code}</code>\n\nThe code works once and expires in ${CODE_TTL_MINUTES} minutes.`,
    );
  }

  // /link CODE — join the pack the code points to.
  const code = args.toUpperCase().replace(/\s+/g, '');
  const row = await db.select().from(linkCodes).where(eq(linkCodes.code, code)).get();
  if (!row || row.expires.getTime() < Date.now()) {
    if (row) await db.delete(linkCodes).where(eq(linkCodes.code, code)).run();
    return reply(message, 'That code is invalid or has expired. Ask for a new one with /link in the other group.');
  }

  const target = await db.select().from(packs).where(eq(packs.setName, row.setName)).get();
  if (!target) {
    await db.delete(linkCodes).where(eq(linkCodes.code, code)).run();
    return reply(message, 'That pack no longer exists.');
  }

  const current = await getPack(chatId);
  if (current && current.setName === target.setName) {
    return reply(message, `This group already adds to ${packAnchor(target)}.`);
  }

  const own = await getOwnPack(chatId);
  if (own && own.setName === target.setName) {
    // Linking back to this group's own pack is the same as unlinking.
    await db.delete(links).where(eq(links.chatId, chatId)).run();
  } else {
    await db.insert(links)
      .values({ chatId, setName: target.setName, linkedBy: message.from?.id ?? null })
      .onConflictDoUpdate({ target: links.chatId, set: { setName: target.setName, linkedBy: message.from?.id ?? null } })
      .run();
  }
  await db.delete(linkCodes).where(eq(linkCodes.code, code)).run();

  const kept = own && own.setName !== target.setName
    ? `\nThis group's own pack ${packAnchor(own)} is kept — /unlink to switch back to it.`
    : '';
  const notice = await reply(message, `✅ Linked! /add here now goes to ${packAnchor(target)}.${kept}`);

  // Let the group that shared the code know.
  try {
    await api.sendMessage({
      chat_id: row.fromChatId,
      text: `🔗 ${escapeHtml(message.chat.title || 'Another group')} is now adding to ${packAnchor(target)}.`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    console.warn('could not notify source group', e);
  }
  return notice;
}

async function unlink(message) {
  if (!(await isAdmin(message))) return reply(message, 'Only group admins can unlink.');
  const chatId = message.chat.id;
  const linked = await db.select().from(links).where(eq(links.chatId, chatId)).get();
  if (!linked) {
    return reply(message, 'This group isn\'t linked to another group\'s pack. (A pack this group created can\'t be unlinked from itself.)');
  }

  await db.delete(links).where(eq(links.chatId, chatId)).run();
  const own = await getOwnPack(chatId);
  return reply(
    message,
    own
      ? `Unlinked. /add here goes to this group's own pack ${packAnchor(own)} again.`
      : 'Unlinked. The next /add here will start a new pack for this group.',
  );
}

// /debug — show exactly what Telegram delivered, plus what the bot thinks of it.
async function debug(message) {
  const pack = await getPack(message.chat.id);
  const summary = [
    `chat: ${message.chat.id} (${message.chat.type}${message.chat.is_forum ? ', topics on' : ''})`,
    `pack: ${pack ? `${pack.setName}${pack.linked ? ' (linked)' : ' (own)'}` : 'none'}`,
    `sticker found: ${repliedSticker(message) ? 'yes' : 'no'}`,
    `reply: ${describeReply(message)}`,
  ].join('\n');
  let raw = JSON.stringify(message, null, 1);
  if (raw.length > 3000) raw = raw.slice(0, 3000) + '\n…(cut)';
  return reply(message, `<b>Debug</b>\n<pre>${escapeHtml(summary)}</pre>\n<pre>${escapeHtml(raw)}</pre>`);
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
