import { openai } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"

import type { GameModelId } from "./model-catalog"

/**
 * The provider instance behind each catalog entry.
 *
 * Server-side only — constructing these reaches for `OPENAI_API_KEY`, and
 * the provider SDK has no business in a browser bundle. There is no
 * `server-only` marker enforcing that, though, for the same reason `@/lib/db`
 * keeps its marker in a separate entry: the chat agent imports this module and
 * runs in the Trigger.dev worker, where that marker throws. Reach for the
 * catalog instead of this file from anything a client component can touch.
 *
 * `satisfies` rather than an annotation, so the record has to cover every
 * `GameModelId` — a model added to the catalog and forgotten here is a type
 * error, not an undefined model discovered at the top of someone's turn.
 */
export const gameModels = {
  "gpt-6-astra": openai("gpt-6-astra"),
  "gpt-6.1-sol": openai("gpt-6.1-sol"),
  "gpt-6-luna": openai("gpt-6-luna"),
} satisfies Record<GameModelId, LanguageModel>
