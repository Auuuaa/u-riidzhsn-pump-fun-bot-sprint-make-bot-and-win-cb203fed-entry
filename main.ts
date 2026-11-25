// Snapback — a dip-recovery bot for the pump.fun replay (agent-fun/replay/v2).
//
// The grader runs `node /bot/main.ts` with no build step and no dependencies:
// erasable TypeScript only. The trading logic lives in strategy.ts; this file
// only hands the bot to the replay harness through the vendored SDK shim.

import { runBot } from "./vendor/makefun-bot.ts";
import { snapbackBot } from "./strategy.ts";

await runBot(snapbackBot());
