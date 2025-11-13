"""
Memory-optimized Telegram Bingo bot
- Store minimal state on disk.
- Avoid frequent disk writes (no save on each mark).
- Only edit/update players whose card contains the called number.
- When a winner appears (either via call or a player marking), broadcast ONE announcement
  to ALL players & admins listing all winners who have bingo on that number.
- Run GC after resets/calls to reduce memory pressure on Termux/mobile devices.

Usage:
  export BINGO_BOT_TOKEN="your_token_here"
  python bingo_bot.py
"""

import os
import json
import logging
import random
import asyncio
import gc
from typing import Dict, Any, List, Tuple

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    ApplicationBuilder,
    CallbackContext,
    CallbackQueryHandler,
    CommandHandler, ContextTypes,
    Defaults,
)

# ------------------------
# CONFIG
# ------------------------
BOT_TOKEN = "8197096380:AAGqmK1F8yZnbYAaGu0kKfbgXLo3IS1C-W0"  # replace with your token
ADMIN_IDS = [1599897507, 461730092]  # replace with your admin IDs
SAVE_FILE = "maintops.json"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ------------------------
# In-memory state
# ------------------------
players: Dict[str, Dict[str, Any]] = {}  # user_id -> {card, chat_id, message_id, name}
called_numbers: List[int] = []
current_game_active = False
last_called_number = None

# ------------------------
# Persistence
# ------------------------
def save_state():
    """Save only active game state to minimize disk writes."""
    try:
        data = {
            "players": players,
            "called_numbers": called_numbers,
            "current_game_active": current_game_active,
            "last_called_number": last_called_number,
        }
        with open(SAVE_FILE, "w") as f:
            json.dump(data, f)
    except Exception as e:
        logger.warning(f"Failed to save state: {e}")

def load_state():
    """Load saved state if available."""
    global players, called_numbers, current_game_active, last_called_number
    try:
        with open(SAVE_FILE, "r") as f:
            data = json.load(f)
            players = data.get("players", {})
            called_numbers = data.get("called_numbers", [])
            current_game_active = data.get("current_game_active", False)
            last_called_number = data.get("last_called_number", None)
            logger.info("Loaded state from disk.")
    except FileNotFoundError:
        logger.info("No save file found, starting fresh.")
    except Exception as e:
        logger.warning(f"Failed to load state: {e}")

# ------------------------
# Bingo helpers
# ------------------------
def get_bingo_letter(num: int) -> str:
    """Return Bingo letter for a given number."""
    if 1 <= num <= 15:
        return "B"
    elif 16 <= num <= 30:
        return "I"
    elif 31 <= num <= 45:
        return "N"
    elif 46 <= num <= 60:
        return "G"
    elif 61 <= num <= 75:
        return "O"
    return "?"

def generate_card() -> List[List[Any]]:
    """Generate a 5x5 Bingo card with center FREE cell."""
    card_cols = []
    ranges = [(1, 15), (16, 30), (31, 45), (46, 60), (61, 75)]
    for col_range in ranges:
        nums = random.sample(range(col_range[0], col_range[1] + 1), 5)
        card_cols.append(nums)
    card_cols[2][2] = "FREE"  # center
    # transpose columns -> rows
    card_rows = [[card_cols[col][row] for col in range(5)] for row in range(5)]
    return card_rows

def get_card_display_with_header(card: List[List[Any]], last_number: int = None) -> str:
    """Return formatted card with last number header."""
    header = "🇧 🇮 🇳 🇬 🇴"
    lines = []
    if last_number is not None:
        letter = get_bingo_letter(last_number)
        lines.append(f"🎯 Last number: <b>{letter}-{last_number}</b>")
    lines.append(header)
    for row in card:
        line = "  ".join("✅" if cell == "✅" or cell == "FREE" else str(cell).rjust(2) for cell in row)
        lines.append(line)
    return "\n".join(lines)

def get_keyboard(card: List[List[Any]]) -> InlineKeyboardMarkup:
    """Return inline keyboard for card marking."""
    keyboard = []
    for i in range(5):
        row = []
        for j in range(5):
            num = card[i][j]
            text = "✅" if num == "✅" or num == "FREE" else str(num)
            callback_data = f"mark_{i}_{j}"
            row.append(InlineKeyboardButton(text, callback_data=callback_data))
        keyboard.append(row)
    return InlineKeyboardMarkup(keyboard)

def check_win(card: List[List[Any]]) -> bool:
    """Return True if the card has >= 2 completed lines."""
    lines = []
    lines.extend(card)  # rows
    lines.extend([list(col) for col in zip(*card)])  # columns
    lines.append([card[i][i] for i in range(5)])  # diag TL-BR
    lines.append([card[i][4 - i] for i in range(5)])  # diag TR-BL
    completed_lines = sum(all(cell == "✅" or cell == "FREE" for cell in line) for line in lines)
    return completed_lines >= 2

# ------------------------
# Admin / state helpers
# ------------------------
def is_admin(user_id: int) -> bool:
    return user_id in ADMIN_IDS

def reset_game_state():
    """Reset in-memory state and run GC."""
    global players, called_numbers, current_game_active, last_called_number
    players.clear()
    called_numbers.clear()
    current_game_active = False
    last_called_number = None
    save_state()
    gc.collect()
    logger.info("Game state reset and GC run.")

# ------------------------
# Announcements (broadcast)
# ------------------------
async def broadcast_announcement(context: CallbackContext, text: str):
    """Send a message to all players and admins."""
    for pdata in list(players.values()):
        try:
            await context.bot.send_message(chat_id=pdata["chat_id"], text=text, parse_mode="HTML")
        except Exception as e:
            logger.warning(f"Failed to announce to player {pdata.get('name')}: {e}")
    for admin_id in ADMIN_IDS:
        try:
            await context.bot.send_message(chat_id=admin_id, text=text, parse_mode="HTML")
        except Exception as e:
            logger.warning(f"Failed to announce to admin {admin_id}: {e}")

# ------------------------
# Bot command / handlers
# ------------------------
def get_main_menu(is_admin_flag: bool = False) -> InlineKeyboardMarkup:
    """Return main menu keyboard."""
    buttons = [
        [InlineKeyboardButton("🎮 Join Game", callback_data="join")],
        [
            InlineKeyboardButton("🎲 View Called Numbers", callback_data="called_numbers"),
            InlineKeyboardButton("� Last 5 Numbers", callback_data="last_five"),
        ],
        [InlineKeyboardButton("💳 Buy Card", callback_data="buy")],
    ]
    if is_admin_flag:
        buttons.append(
            [
                InlineKeyboardButton("📢 Call Number", callback_data="call"),
                InlineKeyboardButton("🔁 Reset Game", callback_data="admin_reset"),
            ]
        )
    return InlineKeyboardMarkup(buttons)

async def send_winner_announcement_private(context: CallbackContext, user_id: int):
    """Notify individual winner privately."""
    try:
        await context.bot.send_message(chat_id=user_id, text="🏆 You got BINGO! (2 lines)")
    except Exception as e:
        logger.warning(f"Failed to send private winner message to {user_id}: {e}")

# ------------------------
# Marking numbers
# ------------------------
async def mark(update: Update, context: CallbackContext):
    """Handle player marking a cell."""
    global players, current_game_active, last_called_number
    query = update.callback_query
    await query.answer()
    user_id_str = str(query.from_user.id)

    if not query.data.startswith("mark_"):
        return

    try:
        _, i_s, j_s = query.data.split("_")
        i = int(i_s); j = int(j_s)
    except Exception:
        await query.answer("❌ Invalid position.")
        return

    if user_id_str not in players:
        await query.edit_message_text("❌ You haven't joined the game yet.")
        return

    card = players[user_id_str]["card"]
    cell = card[i][j]

    if cell == "FREE" or (isinstance(cell, int) and cell in called_numbers):
        card[i][j] = "✅"
        if check_win(card):
            try:
                await query.edit_message_text(get_card_display_with_header(card, last_called_number), reply_markup=None)
            except Exception:
                pass
            await send_winner_announcement_private(context, int(user_id_str))

            winners: List[Tuple[str, str]] = []
            for uid, pdata in players.items():
                try:
                    if check_win(pdata["card"]):
                        winners.append((uid, pdata.get("name", str(uid))))
                except Exception:
                    logger.warning(f"Error checking win for player {uid}")

            if winners:
                number_text = f"{get_bingo_letter(last_called_number)}-{last_called_number}" if last_called_number else "N/A"
                winners_text = "\n".join([f"- {name}" for _, name in winners])
                announcement = f"🎉 BINGO!\nWinners for number <b>{number_text}</b>:\n{winners_text}"
                await broadcast_announcement(context, announcement)
                current_game_active = False
                save_state()
                gc.collect()
        else:
            try:
                await query.edit_message_text(get_card_display_with_header(card, last_called_number), reply_markup=get_keyboard(card))
            except Exception:
                pass
    else:
        await query.answer("❌ This number hasn't been called yet.")

# ------------------------
# Calling numbers (admin)
# ------------------------
async def call_numbers_call(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Admin command to call a number."""
    global called_numbers, last_called_number, current_game_active

    if update.effective_user.id not in ADMIN_IDS:
        await update.message.reply_text("Only admin can call numbers.")
        return

    if not current_game_active:
        await update.message.reply_text("Game is not active.")
        return

    remaining = [n for n in range(1, 76) if n not in called_numbers]
    if not remaining:
        await update.message.reply_text("All numbers have been called.")
        return

    number = random.choice(remaining)
    called_numbers.append(number)
    last_called_number = number
    save_state()

    updates = 0
    for uid, pdata in list(players.items()):
        try:
            card = pdata["card"]
            await context.bot.edit_message_text(
                chat_id=pdata["chat_id"],
                message_id=pdata["message_id"],
                text=get_card_display_with_header(card, last_number=number),
                reply_markup=get_keyboard(card)
            )
            updates += 1
        except Exception as e:
            logger.warning(f"Failed to update card for {uid}: {e}")

    winners = []
    for uid, pdata in players.items():
        try:
            if check_win(pdata["card"]):
                winners.append((uid, pdata.get("name", str(uid))))
        except Exception as e:
            logger.warning(f"Error checking winner for {uid}: {e}")

    if winners:
        winners_text = "\n".join([f"- {name}" for _, name in winners])
        number_text = f"{get_bingo_letter(number)}-{number}"
        announcement = f"🎉 BINGO!\nLast number: <b>{number_text}</b>\n\nWinners:\n{winners_text}"
        await broadcast_announcement(context, announcement)
        current_game_active = False
        save_state()

    gc.collect()
    logger.info(f"Called number {number}. Updated {updates} cards.")

# ------------------------
# Main menu button handler
# ------------------------
async def handle_buttons(update: Update, context: CallbackContext):
    """Handle main menu button presses."""
    global current_game_active, players, called_numbers, last_called_number
    query = update.callback_query
    user_id_str = str(query.from_user.id)
    chat_id = query.message.chat_id
    await query.answer()

    if query.data == "join":
        if not current_game_active:
            await query.edit_message_text("❌ No game in progress.")
            return
        if user_id_str in players:
            await query.edit_message_text("✅ You already joined.")
            return
        card = generate_card()
        sent = await context.bot.send_message(
            chat_id=chat_id,
            text=get_card_display_with_header(card, last_called_number),
            reply_markup=get_keyboard(card),
        )
        players[user_id_str] = {
            "card": card,
            "chat_id": chat_id,
            "message_id": sent.message_id,
            "name": query.from_user.full_name or str(query.from_user.id),
        }
        save_state()
        await query.edit_message_text("🎟️ You’ve joined the game!")

    elif query.data == "buy":
        await query.edit_message_text("💳 Payment coming soon.")
    elif query.data == "call" and is_admin(int(user_id_str)):
        await call_numbers_call(update, context)
    elif query.data == "admin_reset" and is_admin(int(user_id_str)):
        reset_game_state()
        await query.edit_message_text("🔁 Game reset.")
    elif query.data == "show_card":
        if user_id_str in players:
            card = players[user_id_str]["card"]
            await query.edit_message_text("� Your current card:")
            await context.bot.send_message(chat_id=chat_id, text=get_card_display_with_header(card, last_called_number), reply_markup=get_keyboard(card))
        else:
            await query.edit_message_text("❌ You haven't joined the game yet.")
    elif query.data == "called_numbers":
        if called_numbers:
            formatted = ", ".join(f"{get_bingo_letter(n)}-{n}" for n in called_numbers)
            await query.edit_message_text(f"📜 All Called Numbers:\n<code>{formatted}</code>", reply_markup=get_main_menu(is_admin(int(user_id_str))))
        else:
            await query.edit_message_text("⏳ No numbers have been called yet.")
    elif query.data == "last_five":
        if called_numbers:
            last_five = called_numbers[-5:]
            formatted = ", ".join(f"{get_bingo_letter(n)}-{n}" for n in last_five)
            await query.edit_message_text(f"� Last 5 Called Numbers:\n<code>{formatted}</code>", reply_markup=get_main_menu(is_admin(int(user_id_str))))
        else:
            await query.edit_message_text("⏳ Not enough numbers have been called yet.")
    else:
        await query.answer("Unknown action.")

# ------------------------
# Start / admin commands
# ------------------------
async def start(update: Update, context: CallbackContext):
    """Send main menu to user."""
    user_id = update.effective_user.id
    await update.message.reply_text(
        "🎉 Welcome to Bingo! Click to join or manage the game.",
        reply_markup=get_main_menu(is_admin(user_id)),
    )

async def startgame(update: Update, context: CallbackContext):
    """Admin command to start a fresh game."""
    global current_game_active, players, called_numbers, last_called_number
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("Only admin can start.")
        return
    players.clear()
    called_numbers.clear()
    current_game_active = True
    last_called_number = None
    save_state()
    gc.collect()
    await update.message.reply_text("🎮 New Bingo game started! Join using the menu.")

# ------------------------
# Main function
# ------------------------
async def main():
    defaults = Defaults(parse_mode="HTML")
    app = ApplicationBuilder().token(BOT_TOKEN).defaults(defaults).build()
    load_state()
    logger.info("🤖 Bingo Bot running...")

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("startgame", startgame))
    app.add_handler(CommandHandler("call", call_numbers_call))

    app.add_handler(CallbackQueryHandler(handle_buttons, pattern="^(join|buy|show_card|called_numbers|last_five|call|admin_reset)$"))
    app.add_handler(CallbackQueryHandler(mark, pattern="^mark_"))

    await app.run_polling()

if __name__ == "__main__":
    import nest_asyncio
    nest_asyncio.apply()
    asyncio.run(main())
