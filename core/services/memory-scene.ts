import { createHash } from "node:crypto";

import type { MemorySceneIntent } from "../ports/memory-context.js";
import type { VariantResolution } from "./variant-resolver.js";

/**
 * Public host convention for projecting explicit persona state onto memory
 * scope. It is intentionally boring and inspectable:
 *
 * - `intimacy` means the owner explicitly enabled the intimacy memory lane;
 * - one `au-<id>` variant means that AU is active;
 * - no AU variant means ordinary;
 * - more than one AU variant is ambiguous and therefore `unknown`.
 *
 * No text classifier or model call participates in this decision.
 */
export function deriveMemoryScene(
  resolution: Pick<VariantResolution, "personaId" | "blocks" | "metadata">,
): { scene: MemorySceneIntent; variantSha256: string } {
  const activeVariantIds = resolution.metadata.variants.map((variant) => variant.id);
  const intimacyActive = activeVariantIds.includes("intimacy");
  const auIds = activeVariantIds
    .filter((id) => id.startsWith("au-") && id.length > 3)
    .map((id) => id.slice(3));

  let scene: MemorySceneIntent;
  if (auIds.length === 0) {
    scene = { mode: "ordinary", intimacyActive };
  } else if (auIds.length === 1) {
    scene = { mode: "au", auId: auIds[0]!, intimacyActive };
  } else {
    scene = { mode: "unknown", intimacyActive };
  }

  // Content-sensitive, metadata-only identity of the exact resolved persona
  // authority for this turn. The memory decision backlog stores only this
  // digest, never persona block bodies.
  const variantSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        personaId: resolution.personaId,
        blocks: resolution.blocks.map((block) => ({
          path: block.path,
          reason: block.reason,
          contentSha256: createHash("sha256").update(block.content, "utf8").digest("hex"),
        })),
      }),
      "utf8",
    )
    .digest("hex");

  return { scene, variantSha256 };
}
