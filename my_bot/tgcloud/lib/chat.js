import { api } from 'sdk';

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function reply(message, html) {
  return api.sendMessage({
    chat_id: message.chat.id,
    text: html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
}

export function mention(user) {
  return `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name)}</a>`;
}

export async function isAdmin(message) {
  // Anonymous admins post "as the group".
  if (message.sender_chat && message.sender_chat.id === message.chat.id) return true;
  if (!message.from) return false;
  const member = await api.getChatMember({ chat_id: message.chat.id, user_id: message.from.id });
  return member.status === 'creator' || member.status === 'administrator';
}
