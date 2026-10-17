import { table, integer, text, index, sql } from 'sdk/db';

// The group that created a pack ("home" group).
export const packs = table('packs', {
  chatId:  integer('chat_id').primaryKey(),
  setName: text('set_name').notNull().unique(),   // e.g. g1a2b3c_by_mybot
  title:   text('title').notNull(),
  ownerId: integer('owner_id').notNull(),         // Telegram requires every bot-made pack to have a human owner
  created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Other groups that share a pack. A link takes priority over a group's own pack,
// so /unlink brings the group back to its own pack (if it has one).
export const links = table('links', {
  chatId:   integer('chat_id').primaryKey(),
  setName:  text('set_name').notNull(),
  linkedBy: integer('linked_by'),
  created:  integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  bySet: index('idx_links_set').on(t.setName),
}));

// One-time codes made by /link, used by /link <code> in another group.
export const linkCodes = table('link_codes', {
  code:       text('code').primaryKey(),
  setName:    text('set_name').notNull(),
  fromChatId: integer('from_chat_id').notNull(),
  expires:    integer('expires_at', { mode: 'timestamp' }).notNull(),
});
