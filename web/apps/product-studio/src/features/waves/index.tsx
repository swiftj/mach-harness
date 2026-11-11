import { Layers } from "lucide-react";
import type { Feature } from "../types";
import { ReviewScreen } from "./ReviewScreen";
import { SendScreen } from "./SendScreen";
import { WavesScreen } from "./WavesScreen";

/**
 * Delivery waves: group approved slices, approve a wave, send it to engineering, follow review.
 *   /waves                  the waves
 *   /waves/:waveId/send     the guided send flow (check, confirm, result)
 *   /waves/:waveId/review   how review of a sent wave is going
 */
export const feature: Feature = {
  routes: [
    {
      path: "waves",
      children: [
        { index: true, element: <WavesScreen /> },
        { path: ":waveId/send", element: <SendScreen /> },
        { path: ":waveId/review", element: <ReviewScreen /> },
      ],
    },
  ],
  nav: { to: "/waves", label: "Delivery waves", icon: Layers, section: "deliver", order: 50 },
};
