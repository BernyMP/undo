import { defineTool } from "eve/tools";
import { z } from "zod";

// A plain tool that only reads. undo treats it as a write until it is listed in `reads`.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: z.object({ id: z.string() }),
  async execute({ id }) {
    return { id, status: "shipped" };
  },
});
