# Group Sticker Pack Bot (Telegram Serverless)

Add the bot to a group and anyone can grow a shared sticker pack by replying to a sticker with `/add`.

## Commands (in a group)

| Command | Who | What |
|---|---|---|
| `/add` (reply to a sticker) | everyone | Adds the sticker to the group's pack. The first `/add` creates the pack. |
| `/add 😂🔥` | everyone | Same, with your own emoji instead of the sticker's |
| `/pack` | everyone | Link to the pack |
| `/remove` (reply to a sticker from the pack) | admins | Removes it |
| `/rename New title` | admins | Renames the pack |

## Setup

1. In @BotFather: open your bot → **Serverless** → turn it on. Copy the token under **CLI Access**.
2. Create a project and drop these files in:
   ```bash
   npm create @tgcloud/bot sticker-pack-bot
   cd sticker-pack-bot
   # replace the tgcloud/ folder with the one from this zip
   npx tgcloud login
   npx tgcloud push
   npx tgcloud migrate
   ```
3. Optional, in @BotFather → your bot → Edit Commands:
   ```
   add - Reply to a sticker to add it to the group pack
   pack - Get the group pack link
   remove - (admins) Remove a sticker from the pack
   rename - (admins) Rename the pack
   ```
4. Add the bot to a group. Leave **privacy mode on** — the bot only needs commands.

## How it works / things to know

- **Owner.** Telegram requires every bot-made pack to belong to a real user. Whoever sends the first `/add` becomes the owner; if they've never started the bot privately, the bot asks them to tap Start first. The owner can also edit the pack in @Stickers.
- **Formats.** Static, animated and video stickers can all go in the same pack. The bot re-uses Telegram's file_id, so nothing is downloaded or re-uploaded.
- **Limit.** 120 stickers per pack.
- **Supergroup upgrades** (which change the chat id) are handled automatically.
- Photos aren't supported: Telegram needs 512px PNG/WEBP for static stickers, and the Serverless runtime has no image library. That would need an external resize API via `fetch`.
