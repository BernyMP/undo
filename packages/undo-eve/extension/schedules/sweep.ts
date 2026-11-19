import { defineSchedule } from "eve/schedules";
import { getConfig, sweep } from "../lib/index.ts";

// Runs held actions the in-process timer missed, e.g. after a restart on a
// serverless host. `eve dev` doesn't fire schedules on their cadence; locally the
// timer, the startup sweep and every ledger API read cover it.
export default defineSchedule({
  cron: "* * * * *",
  async run() {
    if (getConfig()) await sweep();
  },
});
