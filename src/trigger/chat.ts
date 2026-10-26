import { chat, upsertIncomingMessage } from "@trigger.dev/sdk/ai"
import { stepCountIs, streamText } from "ai"
import { z } from "zod"

import { createGameSandbox } from "@/lib/daytona/utils"
import { gameModelSettings } from "@/lib/games/agent"
import {
  loadGameMessages,
  saveGameMessages,
  saveGameTurn,
} from "@/lib/games/chat-store"
import { gameInstructions } from "@/lib/games/instructions"
import {
  DEFAULT_GAME_MODEL_ID,
  isGameModelId,
  type GameModelId,
} from "@/lib/games/model-catalog"
import { createGameTools } from "@/lib/games/tools"
import { describeError, elapsed, logger } from "@/lib/observability"

// Everything the browser gets to say about a turn, which is the model to run it
// on and nothing else. The id is checked against the catalog rather than taken
// as a string, so a tab naming a model this app doesn't offer — or one that
// doesn't exist — is rejected here instead of at the provider.
//
// Optional at both levels because there is no picker yet: nothing sends client
// data at all today, and a turn with none runs on `DEFAULT_GAME_MODEL_ID`.
const gameClientDataSchema = z
  .object({
    modelId: z
      .custom<GameModelId>((value) => isGameModelId(value), {
        message: "Unknown model",
      })
      .optional(),
  })
  .optional()

// A turn is a read-edit-read loop over the game's files, so it needs room for
// many steps; the default of one would stop the turn dead after the first tool
// call, before the model has said anything.
const MAX_STEPS = 48

/**
 * A game's chat thread, run as one long-lived task per conversation.
 *
 * A game owns exactly one thread and the chat id is the game id, so the
 * `games` row stays the source of truth for history: `hydrateMessages` reads it
 * back at the top of every turn instead of trusting the copy the browser holds.
 *
 * Authorization happens before a session can exist, in the server actions in
 * `@/lib/games/chat-actions` — there is no Clerk session in here to scope by.
 */
export const gameChat = chat.agent({
  id: "game-chat",
  clientDataSchema: gameClientDataSchema,
  hydrateMessages: async ({ chatId, trigger, incomingMessages }) => {
    const startedAt = performance.now()
    const stored = await loadGameMessages(chatId)

    // Appends a genuinely new user message and no-ops otherwise. A new game is
    // created with its opening prompt already stored, and the client replays
    // that same message to ask for the first reply — this dedupes it by id.
    const appended = upsertIncomingMessage(stored, {
      trigger,
      incomingMessages,
    })

    if (appended) {
      await saveGameMessages({ gameId: chatId, messages: stored })
    }

    // Message *counts*, never message content: the thread is the player's
    // prompts and the agent's game source, both of which stay out of Sentry.
    //
    // `appended: false` on what should be a new turn is the signature of the
    // dedupe swallowing a real message.
    logger.info(logger.fmt`Chat turn starting for game ${chatId}`, {
      "game.id": chatId,
      "chat.stored_messages": stored.length,
      "chat.incoming_messages": incomingMessages.length,
      "chat.appended_incoming": appended,
      duration_ms: elapsed(startedAt),
    })

    return stored
  },
  // Fires once per game, on the first message of its thread — so the sandbox
  // is created exactly once and is already seeded before `run` streams a reply.
  onChatStart: async ({ chatId }) => {
    try {
      await createGameSandbox(chatId)
    } catch (error) {
      logger.error(
        logger.fmt`Could not create the sandbox for game ${chatId}`,
        { "game.id": chatId, ...describeError(error) }
      )

      throw error
    }
  },
  onTurnComplete: async ({
    chatId,
    uiMessages,
    chatAccessToken,
    lastEventId,
    clientData,
  }) => {
    const startedAt = performance.now()

    try {
      await saveGameTurn({
        gameId: chatId,
        messages: uiMessages,
        chatAccessToken,
        chatLastEventId: lastEventId,
      })
    } catch (error) {
      logger.error(
        logger.fmt`Could not persist the finished turn for game ${chatId}`,
        {
          "game.id": chatId,
          "chat.messages": uiMessages.length,
          "chat.has_cursor": lastEventId !== undefined,
          ...describeError(error),
        }
      )

      throw error
    }

    // Pairs with the `Chat turn starting` log above: one of each per turn.
    logger.info(logger.fmt`Chat turn complete for game ${chatId}`, {
      "game.id": chatId,
      "gen_ai.request.model": clientData?.modelId ?? DEFAULT_GAME_MODEL_ID,
      "chat.messages": uiMessages.length,
      "chat.has_cursor": lastEventId !== undefined,
      duration_ms: elapsed(startedAt),
    })
  },
  // Resolved per turn: the tools write into this game's sandbox, and the chat
  // id is the game id. Declared on the config and handed back to `streamText`
  // so history re-converted on a later turn has the same set to make sense of
  // the tool calls already in it.
  tools: ({ chatId }) => createGameTools(chatId),
  run: async ({ messages, tools, signal, clientData }) =>
    streamText({
      // Spread first, so every option below still wins. Wires up the
      // `prepareStep` behind compaction, steering and background injection —
      // all of which silently no-op without it.
      ...chat.toStreamTextOptions({ tools }),
      // Read per turn rather than fixed for the thread, so switching models
      // mid-conversation takes effect on the next message.
      ...gameModelSettings(clientData?.modelId ?? DEFAULT_GAME_MODEL_ID),
      instructions: gameInstructions,
      messages,
      // Fires on stop and on cancel. Without it, Stop only updates the UI.
      abortSignal: signal,
      stopWhen: stepCountIs(MAX_STEPS),
    }),
})
