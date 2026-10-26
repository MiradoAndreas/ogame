import type { UIMessage } from "ai"
import { eq } from "drizzle-orm"

// Imported straight from `./client` rather than `@/lib/db`: this module runs
// inside the Trigger.dev worker, where the `server-only` marker on the `@/lib/db`
// entry would throw.
import { db, games } from "@/lib/db/client"

/**
 * A game's stored chat thread.
 *
 * Lookups here are by id alone, with no org scoping, unlike `getGame`. The
 * caller is the chat agent, which has no Clerk session to scope by — a game id
 * only ever reaches it through a session the server actions in
 * `@/lib/games/chat-actions` already authorized against the caller's org.
 */
export async function loadGameMessages(gameId: string): Promise<UIMessage[]> {
  try {
    console.log("Loadede Game messages functions call here ...")
    const [game] = await db
      .select({ messages: games.messages })
      .from(games)
      .where(eq(games.id, gameId))
      .limit(1)

    console.log("Game found with game.messages : ", game.messages)

    return game?.messages ?? []

  } catch (error) {
    console.log("Loaded game cause an error ")
    console.error("[chat-store] load failed:", error)
    console.error("[chat-store] cause:", (error as Error).cause)
    throw error
  }
}

/**
 * Replaces a game's chat thread.
 *
 * The thread is stored whole on every turn, so the caller passes the complete
 * message list rather than an append.
 */
export async function saveGameMessages({
  gameId,
  messages,
}: {
  gameId: string
  messages: UIMessage[]
}): Promise<void> {
  console.log("SAVING GAME MESSAGES....")
  await db.update(games).set({ messages }).where(eq(games.id, gameId))
  console.log("UPDATE SUCCESSFULY")
}

/**
 * Replaces a game's chat thread and the stream cursor for it.
 *
 * One statement, so the two can't diverge: a reload landing between separate
 * writes would resume from a cursor that points past messages the row doesn't
 * have yet, and replay the assistant turn on top of itself.
 */
export async function saveGameTurn({
  gameId,
  messages,
  chatAccessToken,
  chatLastEventId,
}: {
  gameId: string
  messages: UIMessage[]
  chatAccessToken: string
  chatLastEventId: string | undefined
}): Promise<void> {
  try {
    await db
      .update(games)
      .set({ messages, chatAccessToken, chatLastEventId })
      .where(eq(games.id, gameId))
  }
  catch (error) {
    console.log("ERROR saveGameTurn : ", error)
  }
}
