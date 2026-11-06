import type { Metadata } from "next";
import { MotionLab } from "@/components/lab/motion-lab";

export const metadata: Metadata = { title: "Motion lab · erodoro", robots: { index: false } };

/** Side-by-side previews of the retro motion options for the landing. Not linked anywhere. */
export default function MotionLabPage() {
  return <MotionLab />;
}
